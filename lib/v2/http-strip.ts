import type { IdFormat } from "../message-ids"
import { createDeltaStripper, type DeltaStripper } from "./language-strip"

export interface HttpResponseLike {
    kind: string
    response: Response
}

const SSE_BOUNDARY = /\r?\n\r?\n/
const DATA_LINE = /^(data:)([ \t]?)(.*)$/

// Native-packaged providers (e.g. opencode-go) never run the `aisdk.language` hook,
// so echoed IDs have to come off the raw provider stream instead. Only the primary
// model request is touched, and only frames matching a known protocol are rewritten.
export function stripHttpResponseEchoes(
    event: HttpResponseLike,
    format: IdFormat = "compact",
): void {
    if (event.kind !== "primary") {
        return
    }

    const contentType = event.response.headers.get("content-type") ?? ""
    if (!contentType.toLowerCase().includes("text/event-stream")) {
        return
    }

    const body = event.response.body
    if (!body) {
        return
    }

    event.response = new Response(body.pipeThrough(createSseStripTransform(format)), {
        status: event.response.status,
        statusText: event.response.statusText,
        headers: event.response.headers,
    })
}

function createSseStripTransform(format: IdFormat): TransformStream<Uint8Array, Uint8Array> {
    const stripper = createDeltaStripper(format)
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    let pending = ""

    return new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
            pending += decoder.decode(chunk, { stream: true })
            let boundary = SSE_BOUNDARY.exec(pending)
            while (boundary !== null) {
                const end = boundary.index + boundary[0].length
                controller.enqueue(encoder.encode(rewriteFrame(pending.slice(0, end), stripper)))
                pending = pending.slice(end)
                boundary = SSE_BOUNDARY.exec(pending)
            }
        },
        flush(controller) {
            pending += decoder.decode()
            if (pending.length > 0) {
                controller.enqueue(encoder.encode(rewriteFrame(pending, stripper)))
            }
            const remaining = stripper.flush()
            if (remaining.length > 0) {
                controller.enqueue(encoder.encode(syntheticFrames(remaining)))
            }
        },
    })
}

function rewriteFrame(frame: string, stripper: DeltaStripper): string {
    const lines = frame.split(/(\r?\n)/)
    for (let index = 0; index < lines.length; index += 2) {
        const line = lines[index]
        if (line === undefined) continue
        const match = DATA_LINE.exec(line)
        if (!match) continue
        const payload = match[3] ?? ""
        if (payload.trim() === "[DONE]") continue
        const rewritten = rewritePayload(payload, stripper)
        if (rewritten !== undefined) {
            lines[index] = `${match[1]}${match[2]}${rewritten}`
        }
    }
    return lines.join("")
}

function rewritePayload(payload: string, stripper: DeltaStripper): string | undefined {
    let parsed: unknown
    try {
        parsed = JSON.parse(payload)
    } catch {
        return undefined
    }
    if (!rewriteChatChunk(parsed, stripper)) {
        return undefined
    }
    return JSON.stringify(parsed)
}

function rewriteChatChunk(value: unknown, stripper: DeltaStripper): boolean {
    if (typeof value !== "object" || value === null) return false
    const choices = (value as { choices?: unknown }).choices
    if (!Array.isArray(choices)) return false

    let touched = false
    for (let index = 0; index < choices.length; index++) {
        const choice = choices[index]
        if (typeof choice !== "object" || choice === null) continue
        const record = choice as { index?: unknown; delta?: unknown; finish_reason?: unknown }
        const delta = record.delta
        if (typeof delta !== "object" || delta === null) continue

        const key = `chat:${typeof record.index === "number" ? record.index : index}`
        const content = (delta as { content?: unknown }).content
        if (typeof content === "string") {
            ;(delta as { content: string }).content = stripper.push(key, content)
            touched = true
        }

        if (record.finish_reason !== null && record.finish_reason !== undefined) {
            const remaining = stripper.end(key)
            if (remaining.length > 0) {
                const emitted =
                    typeof content === "string" ? (delta as { content: string }).content : ""
                ;(delta as { content: string }).content = emitted + remaining
            }
            touched = true
        }
    }
    return touched
}

function syntheticFrames(remaining: Array<{ id: string; delta: string }>): string {
    return remaining
        .map(
            ({ delta }) =>
                `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: delta } }] })}\n\n`,
        )
        .join("")
}
