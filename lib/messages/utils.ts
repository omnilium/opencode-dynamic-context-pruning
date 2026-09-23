import { createHash } from "node:crypto"
import type { SessionState, WithParts } from "../state"
import { isMessageCompacted } from "../state/utils"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import type { IdFormat } from "../message-ids"
import { DCP_PAIRED_TAG_REGEX, DCP_UNPAIRED_TAG_REGEX } from "../dcp-tags"

const SUMMARY_ID_HASH_LENGTH = 16
const DCP_BLOCK_ID_TAG_REGEX = /(<dcp-message-id(?=[\s>])[^>]*>)b\d+(<\/dcp-message-id>)/g
const INJECTED_MESSAGE_ID_SUFFIX_REGEX = /(?<=\n)<dcp-message-id[^>]*>m\d+<\/dcp-message-id>\s*$/
const HALLUCINATED_PARAMETER_SUFFIX_REGEX = /(?<=\n)m\d+<\/parameter>\s*$/
const COMPACT_TAG_SUFFIX = /@(?:\d+|b\d+|blocked)@(?:[ \t]+\[(?:low|medium|high)\])?[ \t\r\n]*$/i

const generateStableId = (prefix: string, seed: string): string => {
    const hash = createHash("sha256").update(seed).digest("hex").slice(0, SUMMARY_ID_HASH_LENGTH)
    return `${prefix}_${hash}`
}

export const createSyntheticUserMessage = (
    baseMessage: WithParts,
    content: string,
    stableSeed?: string,
): WithParts => {
    const userInfo = baseMessage.info as UserMessage
    const now = Date.now()
    const deterministicSeed = stableSeed?.trim() || userInfo.id
    const messageId = generateStableId("msg_dcp_summary", deterministicSeed)
    const partId = generateStableId("prt_dcp_summary", deterministicSeed)

    return {
        info: {
            id: messageId,
            sessionID: userInfo.sessionID,
            role: "user" as const,
            agent: userInfo.agent,
            model: userInfo.model,
            time: { created: now },
        },
        parts: [
            {
                id: partId,
                sessionID: userInfo.sessionID,
                messageID: messageId,
                type: "text" as const,
                text: content,
            },
        ],
    }
}

export const createSyntheticTextPart = (
    baseMessage: WithParts,
    content: string,
    stableSeed?: string,
) => {
    const userInfo = baseMessage.info as UserMessage
    const deterministicSeed = stableSeed?.trim() || userInfo.id
    const partId = generateStableId("prt_dcp_text", deterministicSeed)

    return {
        id: partId,
        sessionID: userInfo.sessionID,
        messageID: userInfo.id,
        type: "text" as const,
        text: content,
    }
}

type MessagePart = WithParts["parts"][number]
type ToolPart = Extract<MessagePart, { type: "tool" }>
type TextPart = Extract<MessagePart, { type: "text" }>

export const appendToLastTextPart = (message: WithParts, injection: string): boolean => {
    const textPart = findLastTextPart(message)
    if (!textPart) {
        return false
    }

    return appendToTextPart(textPart, injection)
}

const findLastTextPart = (message: WithParts): TextPart | null => {
    for (let i = message.parts.length - 1; i >= 0; i--) {
        const part = message.parts[i]
        if (part.type === "text") {
            return part
        }
    }

    return null
}

export const appendToTextPart = (part: TextPart, injection: string): boolean => {
    if (typeof part.text !== "string") {
        return false
    }

    const normalizedInjection = injection.replace(/^\n+/, "")
    if (!normalizedInjection.trim()) {
        return false
    }
    if (part.text.includes(normalizedInjection)) {
        return true
    }

    const baseText = part.text.replace(/\n*$/, "")
    part.text = baseText.length > 0 ? `${baseText}\n\n${normalizedInjection}` : normalizedInjection
    return true
}

export const appendToAllToolParts = (message: WithParts, tag: string): boolean => {
    let injected = false
    for (const part of message.parts) {
        if (part.type === "tool") {
            injected = appendToToolPart(part, tag) || injected
        }
    }
    return injected
}

export const appendToToolPart = (part: ToolPart, tag: string): boolean => {
    if (part.state?.status !== "completed" || typeof part.state.output !== "string") {
        return false
    }
    if (part.state.output.includes(tag)) {
        return true
    }

    part.state.output = `${part.state.output}${tag}`
    return true
}

export const hasContent = (message: WithParts): boolean => {
    return message.parts.some(
        (part) =>
            (part.type === "text" &&
                typeof part.text === "string" &&
                part.text.trim().length > 0) ||
            (part.type === "tool" &&
                part.state?.status === "completed" &&
                typeof part.state.output === "string"),
    )
}

export function buildToolIdList(state: SessionState, messages: WithParts[]): string[] {
    const toolIds: string[] = []
    for (const msg of messages) {
        if (isMessageCompacted(state, msg)) {
            continue
        }
        const parts = Array.isArray(msg.parts) ? msg.parts : []
        if (parts.length > 0) {
            for (const part of parts) {
                if (part.type === "tool" && part.callID && part.tool) {
                    toolIds.push(part.callID)
                }
            }
        }
    }
    state.toolIdList = toolIds
    return toolIds
}

export const replaceBlockIdsWithBlocked = (text: string, format: IdFormat = "xml"): string => {
    if (format === "compact") return text.replace(/@b[1-9]\d*@/gi, "@blocked@")
    return text.replace(DCP_BLOCK_ID_TAG_REGEX, "$1BLOCKED$2")
}

// The model can echo an ID inline (e.g. "see @4@"), so only trailing tags are removed;
// the preceding newline is preserved to keep the original formatting.
const stripTrailingCompactTags = (text: string): string => {
    let stripped = text
    for (;;) {
        const next = stripped.replace(COMPACT_TAG_SUFFIX, "")
        if (next === stripped) {
            return stripped
        }
        stripped = next
    }
}

export const stripHallucinationsFromString = (text: string, format: IdFormat = "xml"): string => {
    if (format === "compact") text = stripTrailingCompactTags(text)
    const withoutKnownSuffixes = text
        .replace(INJECTED_MESSAGE_ID_SUFFIX_REGEX, "")
        .replace(HALLUCINATED_PARAMETER_SUFFIX_REGEX, "")
    return withoutKnownSuffixes
        .replace(DCP_PAIRED_TAG_REGEX, "")
        .replace(DCP_UNPAIRED_TAG_REGEX, "")
}

export const stripHallucinations = (messages: WithParts[], format: IdFormat = "xml"): void => {
    for (const message of messages) {
        for (const part of message.parts) {
            if (part.type === "text" && typeof part.text === "string") {
                part.text = stripHallucinationsFromString(part.text, format)
            }

            if (
                part.type === "tool" &&
                part.state?.status === "completed" &&
                typeof part.state.output === "string"
            ) {
                part.state.output = stripHallucinationsFromString(part.state.output, format)
            }
        }
    }
}

export const stripTrailingMessageIdTag = (text: string, format: IdFormat = "xml"): string => {
    const stripped =
        format === "compact"
            ? stripTrailingCompactTags(text)
            : text
                  .replace(INJECTED_MESSAGE_ID_SUFFIX_REGEX, "")
                  .replace(HALLUCINATED_PARAMETER_SUFFIX_REGEX, "")
    // The injector separates content from its tag with a blank line; drop that too.
    return stripped === text ? text : stripped.replace(/[ \t\r\n]+$/, "")
}

// The model answers the last message, so leaving that message's own ID at the very
// end of the context invites it to continue the tag. Every older ID stays in place.
export const stripTrailingMessageIdFromLastMessage = (
    messages: WithParts[],
    format: IdFormat = "xml",
): void => {
    const message = messages[messages.length - 1]
    if (!message) return

    for (let index = message.parts.length - 1; index >= 0; index--) {
        const part = message.parts[index]
        if (part.type === "text" && typeof part.text === "string") {
            part.text = stripTrailingMessageIdTag(part.text, format)
            return
        }
        if (
            part.type === "tool" &&
            part.state?.status === "completed" &&
            typeof part.state.output === "string"
        ) {
            part.state.output = stripTrailingMessageIdTag(part.state.output, format)
            return
        }
    }
}
