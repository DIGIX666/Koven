declare module "snarkjs" {
  export interface Groth16Result {
    proof: Record<string, unknown>;
    publicSignals: string[];
  }

  export const groth16: {
    fullProve(
      input: Record<string, unknown>,
      wasmPath: string,
      zkeyPath: string,
    ): Promise<Groth16Result>;
    prove(zkeyPath: string, witnessPath: string): Promise<Groth16Result>;
    verify(
      verificationKey: unknown,
      publicSignals: string[],
      proof: Record<string, unknown>,
    ): Promise<boolean>;
  };

  export const wtns: {
    calculate(
      input: Record<string, unknown>,
      wasmPath: string,
      witnessPath: string,
    ): Promise<void>;
  };
}
