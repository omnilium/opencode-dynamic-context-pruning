import type { IdFormat } from "../message-ids"

type StreamPart = { type: string; id?: string; delta?: string; [key: string]: unknown }
type GenerateResult = { content: Array<Record<string, unknown>>; [key: string]: unknown }
type StreamResult = { stream: ReadableStream<StreamPart>; [key: string]: unknown }

interface LanguageModelLike {
    doGenerate(options: unknown): PromiseLike<GenerateResult>
    doStream(options: unknown): PromiseLike<StreamResult>
}

// A hallucinated tag is newline-prefixed and lands at the very end of the text.
// Anchoring to the suffix leaves legitimate mid-text IDs and email addresses intact.
const COMPACT_TAG_SUFFIX =
    /(?:^|\n+)@(?:\d+|b\d+|blocked)@(?:[ \t]+\[(?:low|medium|high)\])?[ \t]*$/i
const XML_TAG_SUFFIX = /(?:^|\n+)<dcp-message-id>[^<]*<\/dcp-message-id>[ \t]*$/
const XML_PARAMETER_SUFFIX = /(?:^|\n+)m\d+<\/parameter>[ \t]*$/

// Hold back any tail that could still grow into a trailing tag, so a tag split
// across deltas is never emitted in part. MAX_TAG_TAIL bounds the latency that hold adds.
const TAG_TAIL_CANDIDATE = /(?:^|\n+)@(?:[0-9a-z]+@?(?:[ \t]+\[[a-z]*\]?)?[ \t]*)?$/i
const MAX_TAG_TAIL = 40

export function stripTrailingTag(text: string, format: IdFormat = "compact"): string {
    if (format === "compact") {
        return text.replace(COMPACT_TAG_SUFFIX, "")
    }
    return text.replace(XML_TAG_SUFFIX, "").replace(XML_PARAMETER_SUFFIX, "")
}

function safeEmitLength(buffer: string): number {
    const match = buffer.match(TAG_TAIL_CANDIDATE)
    if (!match || match.index === undefined || buffer.length - match.index > MAX_TAG_TAIL) {
        return buffer.length
    }
    return match.index
}

function createTagStrippingTransform(format: IdFormat): TransformStream<StreamPart, StreamPart> {
    const buffers = new Map<string, string>()

    const flushBuffers = (controller: TransformStreamDefaultController<StreamPart>) => {
        for (const [id, buffer] of buffers) {
            const remaining = stripTrailingTag(buffer, format)
            if (remaining.length > 0) {
                controller.enqueue({ type: "text-delta", id, delta: remaining })
            }
        }
        buffers.clear()
    }

    return new TransformStream<StreamPart, StreamPart>({
        transform(part, controller) {
            if (
                part.type === "text-delta" &&
                typeof part.id === "string" &&
                typeof part.delta === "string"
            ) {
                const buffer = (buffers.get(part.id) ?? "") + part.delta
                const emit = safeEmitLength(buffer)
                buffers.set(part.id, buffer.slice(emit))
                if (emit > 0) {
                    controller.enqueue({ ...part, delta: buffer.slice(0, emit) })
                }
                return
            }
            if (part.type === "text-start" && typeof part.id === "string") {
                flushBuffers(controller)
                buffers.set(part.id, "")
                controller.enqueue(part)
                return
            }
            if (part.type === "text-end" && typeof part.id === "string") {
                const buffer = buffers.get(part.id) ?? ""
                buffers.delete(part.id)
                const remaining = stripTrailingTag(buffer, format)
                if (remaining.length > 0) {
                    controller.enqueue({ type: "text-delta", id: part.id, delta: remaining })
                }
                controller.enqueue(part)
                return
            }
            flushBuffers(controller)
            controller.enqueue(part)
        },
        flush(controller) {
            flushBuffers(controller)
        },
    })
}

export interface LanguageHookInput {
    model: { id: string; modelID?: string }
    sdk: { languageModel(id: string): unknown }
    language?: unknown
}

// The host resolves `language` itself when no hook sets it, so a hook must build
// the base model from the provider SDK before wrapping it.
export function createLanguageStripHook(format: IdFormat = "compact") {
    return (input: LanguageHookInput): void => {
        const base =
            input.language ?? input.sdk.languageModel(input.model.modelID ?? input.model.id)
        input.language = stripLanguageModel(base as object, format)
    }
}

export function stripLanguageModel<T extends object>(model: T, format: IdFormat = "compact"): T {
    const base = model as unknown as LanguageModelLike
    // Prototype delegation preserves every property the AI SDK reads off the model.
    const wrapped = Object.assign(Object.create(Object.getPrototypeOf(model)), model) as T &
        LanguageModelLike

    wrapped.doStream = async (options) => {
        const result = await base.doStream(options)
        return { ...result, stream: result.stream.pipeThrough(createTagStrippingTransform(format)) }
    }
    wrapped.doGenerate = async (options) => {
        const result = await base.doGenerate(options)
        return {
            ...result,
            content: result.content.map((part) =>
                part.type === "text" && typeof part.text === "string"
                    ? { ...part, text: stripTrailingTag(part.text, format) }
                    : part,
            ),
        }
    }

    return wrapped
}
