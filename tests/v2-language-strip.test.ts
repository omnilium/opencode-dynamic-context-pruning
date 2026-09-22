import assert from "node:assert/strict"
import test from "node:test"
import {
    createLanguageStripHook,
    stripLanguageModel,
    stripTrailingTag,
} from "../lib/v2/language-strip"

type StreamPart = { type: string; id?: string; delta?: string; [key: string]: unknown }

function baseModel(parts: StreamPart[]) {
    return {
        specificationVersion: "v3",
        provider: "test",
        modelId: "test-model",
        supportedUrls: {},
        doStream: async () => ({
            stream: new ReadableStream<StreamPart>({
                start(controller) {
                    for (const part of parts) {
                        controller.enqueue(part)
                    }
                    controller.close()
                },
            }),
        }),
        doGenerate: async () => ({
            content: [{ type: "text", text: "Generated\n\n@9@" }],
            finishReason: { unified: "stop" },
            usage: { inputTokens: 1, outputTokens: 2 },
            warnings: [],
        }),
    }
}

async function collect(stream: ReadableStream<StreamPart>): Promise<StreamPart[]> {
    const parts: StreamPart[] = []
    const reader = stream.getReader()
    for (;;) {
        const { done, value } = await reader.read()
        if (done) {
            return parts
        }
        parts.push(value)
    }
}

function deltaText(parts: StreamPart[]): string {
    return parts
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta ?? "")
        .join("")
}

test("stripTrailingTag removes a compact message ID echoed at the end", () => {
    assert.equal(stripTrailingTag("Done.\n\n@170@", "compact"), "Done.")
    assert.equal(stripTrailingTag("Done.\n@4@ [high]", "compact"), "Done.")
    assert.equal(stripTrailingTag("Done.\n\n@b3@", "compact"), "Done.")
    assert.equal(stripTrailingTag("@12@", "compact"), "")
    assert.equal(stripTrailingTag("Done.\n\n@4@   ", "compact"), "Done.")
})

test("stripTrailingTag preserves legitimate mid-text compact mentions", () => {
    assert.equal(
        stripTrailingTag("See @4@ and @5@ for details", "compact"),
        "See @4@ and @5@ for details",
    )
    assert.equal(stripTrailingTag("mail a@b.com", "compact"), "mail a@b.com")
    assert.equal(
        stripTrailingTag("Compress @4@ now\n\nThen continue.", "compact"),
        "Compress @4@ now\n\nThen continue.",
    )
})

test("stripTrailingTag removes XML IDs echoed at the end only", () => {
    assert.equal(stripTrailingTag("Done.\n<dcp-message-id>m0004</dcp-message-id>", "xml"), "Done.")
    assert.equal(stripTrailingTag("Done.\nm0340</parameter>", "xml"), "Done.")
    assert.equal(
        stripTrailingTag("Keep <dcp-message-id>m0004</dcp-message-id> inline", "xml"),
        "Keep <dcp-message-id>m0004</dcp-message-id> inline",
    )
})

test("stripLanguageModel strips a streamed tag split across deltas", async () => {
    const wrapped = stripLanguageModel(
        baseModel([
            { type: "text-start", id: "t0" },
            { type: "text-delta", id: "t0", delta: "Hello" },
            { type: "text-delta", id: "t0", delta: " world" },
            { type: "text-delta", id: "t0", delta: "\n\n@1" },
            { type: "text-delta", id: "t0", delta: "70@" },
            { type: "text-end", id: "t0" },
        ]),
        "compact",
    )

    const result = await wrapped.doStream({})
    const parts = await collect(result.stream)

    assert.equal(deltaText(parts), "Hello world")
    assert.equal(parts[0]?.type, "text-start")
    assert.equal(parts.at(-1)?.type, "text-end")
    for (const part of parts) {
        assert.doesNotMatch(part.delta ?? "", /@/, "no partial tag may be emitted")
    }
})

test("stripLanguageModel keeps a compact tag followed by more prose", async () => {
    const wrapped = stripLanguageModel(
        baseModel([
            { type: "text-start", id: "t0" },
            { type: "text-delta", id: "t0", delta: "Hello\n\n@4" },
            { type: "text-delta", id: "t0", delta: "@ and more" },
            { type: "text-end", id: "t0" },
        ]),
        "compact",
    )

    const result = await wrapped.doStream({})
    const parts = await collect(result.stream)

    assert.equal(deltaText(parts), "Hello\n\n@4@ and more")
})

test("stripLanguageModel passes through non-text stream parts in order", async () => {
    const wrapped = stripLanguageModel(
        baseModel([
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t0" },
            { type: "text-delta", id: "t0", delta: "ok" },
            { type: "text-end", id: "t0" },
            { type: "tool-input-start", id: "call_1", toolName: "read" },
            { type: "tool-input-end", id: "call_1" },
        ]),
        "compact",
    )

    const result = await wrapped.doStream({})
    const parts = await collect(result.stream)

    assert.deepEqual(
        parts.map((part) => part.type),
        [
            "stream-start",
            "text-start",
            "text-delta",
            "text-end",
            "tool-input-start",
            "tool-input-end",
        ],
    )
    assert.equal(deltaText(parts), "ok")
})

test("stripLanguageModel strips text content from doGenerate and passes the rest through", async () => {
    const wrapped = stripLanguageModel(baseModel([]), "compact")
    const result = await wrapped.doGenerate({})

    assert.equal(result.content[0]?.text, "Generated")
    assert.deepEqual(result.finishReason, { unified: "stop" })
    assert.deepEqual(result.usage, { inputTokens: 1, outputTokens: 2 })
})

test("stripLanguageModel preserves the base model's other properties", async () => {
    const wrapped = stripLanguageModel(baseModel([]), "compact")
    assert.equal(wrapped.specificationVersion, "v3")
    assert.equal(wrapped.provider, "test")
    assert.equal(wrapped.modelId, "test-model")
})

test("createLanguageStripHook builds the base model from the SDK when none is resolved", async () => {
    const calls: string[] = []
    const input = {
        model: { id: "fallback-id" },
        sdk: {
            languageModel(id: string) {
                calls.push(id)
                return baseModel([
                    { type: "text-start", id: "t0" },
                    { type: "text-delta", id: "t0", delta: "Hi\n\n@3@" },
                    { type: "text-end", id: "t0" },
                ])
            },
        },
        language: undefined as unknown,
    }

    createLanguageStripHook("compact")(input)

    assert.deepEqual(calls, ["fallback-id"])
    const stream = (
        input.language as {
            doStream(options: unknown): Promise<{ stream: ReadableStream<StreamPart> }>
        }
    ).doStream({})
    const parts = await collect((await stream).stream)
    assert.equal(deltaText(parts), "Hi")
})

test("createLanguageStripHook wraps an already-resolved model without rebuilding it", async () => {
    let built = false
    const base = baseModel([
        { type: "text-start", id: "t0" },
        { type: "text-delta", id: "t0", delta: "ok\n\n@7@" },
        { type: "text-end", id: "t0" },
    ])
    const input = {
        model: { id: "id-value", modelID: "model-id-value" },
        sdk: {
            languageModel() {
                built = true
                return base
            },
        },
        language: base as unknown,
    }

    createLanguageStripHook("compact")(input)

    assert.equal(built, false)
    assert.notEqual(input.language, base)
    const stream = (
        input.language as {
            doStream(options: unknown): Promise<{ stream: ReadableStream<StreamPart> }>
        }
    ).doStream({})
    const parts = await collect((await stream).stream)
    assert.equal(deltaText(parts), "ok")
})

test("createLanguageStripHook prefers modelID when building the base model", () => {
    const calls: string[] = []
    const input = {
        model: { id: "id-value", modelID: "model-id-value" },
        sdk: {
            languageModel(id: string) {
                calls.push(id)
                return baseModel([])
            },
        },
        language: undefined as unknown,
    }

    createLanguageStripHook("compact")(input)

    assert.deepEqual(calls, ["model-id-value"])
})

test("stripTrailingTag removes a compact tag followed by a trailing newline", () => {
    assert.equal(stripTrailingTag("Done.\n\n@86@\n", "compact"), "Done.")
    assert.equal(stripTrailingTag("Done.\n\n@86@ \n", "compact"), "Done.")
})

test("stripLanguageModel strips a streamed tag that ends with a newline", async () => {
    const wrapped = stripLanguageModel(
        baseModel([
            { type: "text-start", id: "t0" },
            { type: "text-delta", id: "t0", delta: "Hello\n\n@86@" },
            { type: "text-delta", id: "t0", delta: "\n" },
            { type: "text-end", id: "t0" },
        ]),
        "compact",
    )

    const result = await wrapped.doStream({})
    const parts = await collect(result.stream)

    assert.equal(deltaText(parts), "Hello")
})
