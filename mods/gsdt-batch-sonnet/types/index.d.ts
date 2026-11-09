/** Whether the Sonnet switch is on. */
export type BatchSwitch = boolean

declare module 'claude-code' {
  interface PluginState {
    'gsdt-batch-sonnet': {
      /** A /gsdt-batch run is on: the main loop's requests go to Sonnet. */
      on: BatchSwitch
      /** The skill printed its done line this turn: off when the turn ends. */
      ending: BatchSwitch
    }
  }
}
