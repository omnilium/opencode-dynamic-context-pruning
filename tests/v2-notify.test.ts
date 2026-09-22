import assert from "node:assert/strict"
import test from "node:test"
import { buildToastEvent } from "../lib/v2/notify"
import { rpc } from "../lib/v2/rpc"

test("buildToastEvent fills notification defaults", () => {
    const event = buildToastEvent({ message: "▣ DCP | 1.2K removed" })

    assert.deepEqual(event, {
        title: "DCP",
        message: "▣ DCP | 1.2K removed",
        variant: "info",
        duration: 5000,
    })
})

test("buildToastEvent preserves explicit toast fields", () => {
    const event = buildToastEvent({
        title: "DCP: Compress Notification",
        message: "compressed",
        variant: "success",
        duration: 1000,
    })

    assert.deepEqual(event, {
        title: "DCP: Compress Notification",
        message: "compressed",
        variant: "success",
        duration: 1000,
    })
})

test("the notify RPC event schema validates a well-formed payload", () => {
    const parsed = rpc.events.notify.schema.parse({
        title: "DCP",
        message: "compressed",
        variant: "info",
        duration: 5000,
    })

    assert.equal(parsed.message, "compressed")
})

test("the notify RPC event schema rejects an unknown variant", () => {
    assert.throws(() =>
        rpc.events.notify.schema.parse({
            title: "DCP",
            message: "compressed",
            variant: "nope",
            duration: 5000,
        }),
    )
})
