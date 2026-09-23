// DCP injects <dcp-message-id> tags and <dcp-system-reminder> blocks into the
// model's context; a model can echo them into its output. Both hosts strip that
// echo, so the patterns live here as the single source of truth.
export const DCP_PAIRED_TAG_REGEX = /<dcp[^>]*>[\s\S]*?<\/dcp[^>]*>/gi
export const DCP_UNPAIRED_TAG_REGEX = /<\/?dcp[^>]*>/gi

export function stripDcpTags(text: string): string {
    return text.replace(DCP_PAIRED_TAG_REGEX, "").replace(DCP_UNPAIRED_TAG_REGEX, "")
}
