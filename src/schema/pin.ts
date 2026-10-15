import type { ClaimKind } from '../types.js';
/* eslint-disable @typescript-eslint/no-empty-object-type -- `{} extends Pick<T, K>` is the optional-key test */

type Flat<T> = { [K in keyof T]: T[K] };

/**
 * The wire shape of a TS type: `ClaimKind` widens to `string` (plugins add kinds) and optional
 * properties read the same whether or not they admit `undefined` (zod infers `x?: T | undefined`).
 */
type Wire<T> = T extends ClaimKind
  ? string
  : T extends readonly (infer U)[]
    ? Wire<U>[]
    : T extends object
      ? Flat<
          {
            [K in keyof T as {} extends Pick<T, K> ? never : K]: Wire<T[K]>;
          } & {
            [K in keyof T as {} extends Pick<T, K> ? K : never]?:
              Wire<Exclude<T[K], undefined>> | undefined;
          }
        >
      : T;

/**
 * Compile-time pin: `const _: Same<z.infer<typeof schema>, Interface> = true` fails to typecheck
 * when the schema and the interface drift apart (plain assignability would miss a renamed
 * optional field, hence the identity check).
 */
export type Same<A, B> =
  (<T>() => T extends Wire<A> ? 1 : 2) extends <T>() => T extends Wire<B> ? 1 : 2 ? true : never;
