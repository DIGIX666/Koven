export function topUpAmount(balance: bigint, target: bigint): bigint {
  if (balance < 0n || target <= 0n || target > 9223372036854775807n) throw new Error("Invalid funding balance or target");
  return balance >= target ? 0n : target - balance;
}
