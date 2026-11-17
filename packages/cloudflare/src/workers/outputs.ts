/**
 * The properties of a `$worker` that hold outputs. The `outputs:` clause of
 * `$worker`'s mark lists the same names. The runtime `$worker` can't read the
 * mark, so it reads this list.
 */
export const workerOutputs = ["url"] as const;
