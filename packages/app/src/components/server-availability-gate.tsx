import { type Accessor, type ParentProps, Show } from "solid-js"
import type { ServerConnection } from "@/context/server"

export function ServerAvailabilityGate(
  props: ParentProps<{
    serverKey: Accessor<ServerConnection.Key>
    available: Accessor<boolean>
  }>,
) {
  return (
    <Show when={props.available() ? props.serverKey() : undefined} keyed>
      {props.children}
    </Show>
  )
}
