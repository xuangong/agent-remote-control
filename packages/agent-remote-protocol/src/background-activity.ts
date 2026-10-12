import { Type, type Static } from '@sinclair/typebox';

/** Host-owned annotation; native message content and execution state remain authoritative. */
export const BackgroundActivity = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 128 }),
  kind: Type.Literal('review'),
  status: Type.Union((['pending', 'silent', 'visible', 'failed'] as const).map(value => Type.Literal(value))),
  summary: Type.Optional(Type.String({ maxLength: 2048 })),
}, { additionalProperties: false });
export type BackgroundActivity = Static<typeof BackgroundActivity>;

/** Terminal outcomes cannot regress when history pages or tool lifecycle rows arrive late. */
export function mergeBackgroundActivity(previous: BackgroundActivity | undefined, incoming: BackgroundActivity): BackgroundActivity {
  const priority = { pending: 0, silent: 1, visible: 2, failed: 3 };
  return previous?.id === incoming.id && priority[previous.status] > priority[incoming.status] ? previous : incoming;
}
