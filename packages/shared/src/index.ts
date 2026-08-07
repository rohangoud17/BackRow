/**
 * @backrow/shared — the A<->B contract.
 *
 * The single boundary both engineers code against: WebSocket message shapes,
 * DynamoDB key design, session codes, and validation. Anything here is a
 * shared interface, so changes get reviewed by both of us (see docs/branching).
 */
export * from "./keys";
export * from "./session";
export * from "./poll";
export * from "./qa";
export * from "./messages";
