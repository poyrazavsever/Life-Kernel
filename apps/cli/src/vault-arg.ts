/**
 * Commands take an optional leading vault ID. When the first argument is not a configured vault, the default
 * vault is used and every argument is kept, so `lifekernel rituals` works on a one-vault setup and
 * `lifekernel rituals startup` still picks another.
 */
export function splitVaultArg(args: string[], vaultIds: string[], defaultVault: string): { vaultId: string; rest: string[] } {
  const [first, ...rest] = args;
  return first !== undefined && vaultIds.includes(first) ? { vaultId: first, rest } : { vaultId: defaultVault, rest: args };
}
