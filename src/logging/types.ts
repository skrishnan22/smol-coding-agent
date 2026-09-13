export type LogSink<Event extends object> = (event: Event) => Promise<void>
