declare module "circomlibjs" {
  interface PoseidonField {
    toString(value: unknown): string;
  }

  interface Poseidon {
    (inputs: readonly bigint[]): unknown;
    F: PoseidonField;
  }

  export function buildPoseidon(): Promise<Poseidon>;
}
