export const NOTIFY_VARIANTS = ["info", "success", "warning", "error"] as const

export type NotifyVariant = (typeof NOTIFY_VARIANTS)[number]

export interface NotifyEvent {
    title: string
    message: string
    variant: NotifyVariant
    duration: number
}

export interface ToastBody {
    title?: string
    message: string
    variant?: NotifyVariant
    duration?: number
}

const DEFAULT_TITLE = "DCP"
const DEFAULT_VARIANT: NotifyVariant = "info"
const DEFAULT_DURATION_MS = 5000

export function buildToastEvent(body: ToastBody): NotifyEvent {
    return {
        title: body.title ?? DEFAULT_TITLE,
        message: body.message,
        variant: body.variant ?? DEFAULT_VARIANT,
        duration: body.duration ?? DEFAULT_DURATION_MS,
    }
}
