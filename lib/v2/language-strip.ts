import type { IdFormat } from "../message-ids"
import { DCP_PAIRED_TAG_REGEX, stripDcpTags } from "../dcp-tags"

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
    /(?:^|\n+)@(?:\d+|b\d+|blocked)@(?:[ \t]+\[(?:low|medium|high)\])?[ \t\r\n]*$/i
const XML_TAG_SUFFIX = /(?:^|\n+)<dcp-message-id>[^<]*<\/dcp-message-id>[ \t\r\n]*$/
const XML_PARAMETER_SUFFIX = /(?:^|\n+)m\d+<\/parameter>[ \t\r\n]*$/

// Hold back any tail that could still grow into a trailing tag, so a tag split
// across deltas is never emitted in part. MAX_TAG_TAIL bounds the latency that hold adds.
const TAG_TAIL_CANDIDATE = /(?:^|\n+)@(?:[0-9a-z]+@?(?:[ \t]+\[[a-z]*\]?)?[ \t\r\n]*)?$/i
const MAX_TAG_TAIL = 40

const DCP_CLOSE_TAG = /<\/dcp[^>]*>/i
const DCP_PARTIAL_TAG = /^<\/?(?:d(?:c(?:p(?:-[^>]*)?)?)?)?$/i

// Hold from an opening <dcp-...> until its close arrives so an echoed reminder
// block is dropped whole rather than leaking in part. A trailing partial tag is
// held too, so a split opening tag is never emitted.
function dcpHoldStart(buffer: string): number {
    let hold = buffer.length
    const openings = /<dcp[^>]*>/gi
    let match: RegExpExecArray | null
    while ((match = openings.exec(buffer)) !== null) {
        const after = buffer.slice(match.index + match[0].length)
        if (!DCP_CLOSE_TAG.test(after)) {
            hold = match.index
            break
        }
    }
    const lastOpen = buffer.lastIndexOf("<")
    if (lastOpen !== -1 && lastOpen < hold && DCP_PARTIAL_TAG.test(buffer.slice(lastOpen))) {
        hold = lastOpen
    }
    return hold
}

export function stripTrailingTag(text: string, format: IdFormat = "compact"): string {
    if (format === "compact") {
        return text.replace(COMPACT_TAG_SUFFIX, "")
    }
    return text.replace(XML_TAG_SUFFIX, "").replace(XML_PARAMETER_SUFFIX, "")
}

function safeEmitLength(buffer: string): number {
    let hold = buffer.length
    const match = buffer.match(TAG_TAIL_CANDIDATE)
    if (match && match.index !== undefined && buffer.length - match.index <= MAX_TAG_TAIL) {
        hold = match.index
    }
    return Math.min(hold, dcpHoldStart(buffer))
}

export interface DeltaStripper {
    push(id: string, delta: string): string
    end(id: string): string
    flush(): Array<{ id: string; delta: string }>
}

// Shared by the language-model stream wrapper and the raw provider SSE rewrite:
// both hold back a tail that could still grow into a trailing ID tag.
export function createDeltaStripper(format: IdFormat = "compact"): DeltaStripper {
    const buffers = new Map<string, string>()

    return {
        push(id, delta) {
            const buffer = ((buffers.get(id) ?? "") + delta).replace(DCP_PAIRED_TAG_REGEX, "")
            const emit = safeEmitLength(buffer)
            buffers.set(id, buffer.slice(emit))
            return buffer.slice(0, emit)
        },
        end(id) {
            const buffer = buffers.get(id) ?? ""
            buffers.delete(id)
            return stripTrailingTag(stripDcpTags(buffer), format)
        },
        flush() {
            const remaining: Array<{ id: string; delta: string }> = []
            for (const [id, buffer] of buffers) {
                const stripped = stripTrailingTag(stripDcpTags(buffer), format)
                if (stripped.length > 0) {
                    remaining.push({ id, delta: stripped })
                }
            }
            buffers.clear()
            return remaining
        },
    }
}

function createTagStrippingTransform(format: IdFormat): TransformStream<StreamPart, StreamPart> {
    const stripper = createDeltaStripper(format)

    const flushBuffers = (controller: TransformStreamDefaultController<StreamPart>) => {
        for (const { id, delta } of stripper.flush()) {
            controller.enqueue({ type: "text-delta", id, delta })
        }
    }

    return new TransformStream<StreamPart, StreamPart>({
        transform(part, controller) {
            if (
                part.type === "text-delta" &&
                typeof part.id === "string" &&
                typeof part.delta === "string"
            ) {
                const emit = stripper.push(part.id, part.delta)
                if (emit.length > 0) {
                    controller.enqueue({ ...part, delta: emit })
                }
                return
            }
            if (part.type === "text-start" && typeof part.id === "string") {
                flushBuffers(controller)
                controller.enqueue(part)
                return
            }
            if (part.type === "text-end" && typeof part.id === "string") {
                const remaining = stripper.end(part.id)
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
                    ? { ...part, text: stripTrailingTag(stripDcpTags(part.text), format) }
                    : part,
            ),
        }
    }

    return wrapped
}
