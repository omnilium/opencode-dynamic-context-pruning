import assert from "node:assert/strict"
import test from "node:test"
import { stripHttpResponseEchoes } from "../lib/v2/http-strip"

function chatFrame(content: string | null, finish: string | null = null): string {
    return `data: ${JSON.stringify({
        id: "chunk",
        object: "chat.completion.chunk",
        choices: [{ index: 0, finish_reason: finish, delta: { content, reasoning_content: null } }],
    })}\n\n`
}

function event(frames: string[], kind = "primary", contentType = "text/event-stream") {
    const body = frames.join("")
    return {
        kind,
        response: new Response(body, { status: 200, headers: { "content-type": contentType } }),
    }
}

function contentOf(text: string): string {
    let out = ""
    for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue
        const payload = line.slice(5).trim()
        if (payload === "[DONE]") continue
        try {
            const parsed = JSON.parse(payload) as {
                choices?: Array<{ delta?: { content?: unknown } }>
            }
            const content = parsed.choices?.[0]?.delta?.content
            if (typeof content === "string") out += content
        } catch {
            continue
        }
    }
    return out
}

test("stripHttpResponseEchoes removes a tag split across SSE frames", async () => {
    const target = event([
        chatFrame("Hello\n\n@8"),
        chatFrame("6@"),
        chatFrame("", "stop"),
        "data: [DONE]\n\n",
    ])

    stripHttpResponseEchoes(target, "compact")

    const text = await target.response.text()
    assert.equal(contentOf(text), "Hello")
    assert.match(text, /data: \[DONE\]/)
})

test("stripHttpResponseEchoes keeps a mid-text tag and following prose", async () => {
    const target = event([
        chatFrame("Use @4"),
        chatFrame("@ now\n\n@b2@"),
        chatFrame("", "stop"),
        "data: [DONE]\n\n",
    ])

    stripHttpResponseEchoes(target, "compact")

    assert.equal(contentOf(await target.response.text()), "Use @4@ now")
})

test("stripHttpResponseEchoes leaves tool call deltas untouched", async () => {
    const toolFrame = `data: ${JSON.stringify({
        choices: [
            {
                index: 0,
                finish_reason: null,
                delta: {
                    content: null,
                    tool_calls: [
                        { index: 0, id: "call_1", function: { name: "read", arguments: "" } },
                    ],
                },
            },
        ],
    })}\n\n`
    const target = event([toolFrame, chatFrame("", "tool_calls"), "data: [DONE]\n\n"])

    stripHttpResponseEchoes(target, "compact")

    const text = await target.response.text()
    assert.match(text, /"tool_calls"/)
    assert.match(text, /"call_1"/)
})

test("stripHttpResponseEchoes ignores non-primary requests", async () => {
    const frames = [chatFrame("Done\n\n@7@"), chatFrame("", "stop"), "data: [DONE]\n\n"]
    const target = event(frames, "title")

    stripHttpResponseEchoes(target, "compact")

    assert.equal(await target.response.text(), frames.join(""))
})

test("stripHttpResponseEchoes ignores non-SSE responses", async () => {
    const target = event(
        ['{"choices":[{"delta":{"content":"Done @7@"}}]}'],
        "primary",
        "application/json",
    )

    stripHttpResponseEchoes(target, "compact")

    assert.equal(await target.response.text(), '{"choices":[{"delta":{"content":"Done @7@"}}]}')
})
