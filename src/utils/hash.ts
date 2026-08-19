import crypto from "node:crypto";

interface TransferRequest {
    debitAccountId: string;
    destinationAccount: string;
    amount: number;
}

export function createRequestHash(input: TransferRequest): string {
    return crypto
        .createHash("sha256")
        .update(JSON.stringify({
            debitAccountId: input.debitAccountId,
            destinationAccount: input.destinationAccount,
            amount: input.amount,
        })).digest("hex");
}


