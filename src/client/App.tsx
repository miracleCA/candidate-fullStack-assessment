import { type FormEvent, useCallback, useEffect, useState } from "react";

interface Account {
  id: string;
  name: string;
  balance: number;
}

type TransferStatus = "pending" | "uncertain" | "succeeded" | "failed" | "reversed";

interface Transfer {
  id: string;
  destinationAccount: string;
  amount: number;
  status: TransferStatus;
  createdAt: string;
}

const headers = {
  "Content-Type": "application/json",
  "x-demo-user": "user-a",
};

const money = new Intl.NumberFormat("en-NG", {
  style: "currency",
  currency: "NGN",
});

const statusOptions: Array<{ value: "" | TransferStatus; label: string }> = [
  { value: "", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "uncertain", label: "Needs reconciliation" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
  { value: "reversed", label: "Reversed" },
];

async function getErrorMessage(response: Response): Promise<string> {
  try {
    const result = await response.json();
    return result.error ?? "Request failed";
  } catch {
    return "Request failed";
  }
}

export function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);

  const [destinationAccount, setDestinationAccount] = useState("0000000001");

  const [amount, setAmount] = useState("10000");
  const [statusFilter, setStatusFilter] = useState<"" | TransferStatus>("");

  const [loading, setLoading] = useState(true);
  const [loadingTransfers, setLoadingTransfers] = useState(false);
  const [sending, setSending] = useState(false);
  const [reconciling, setReconciling] = useState(false);

  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const refresh = useCallback(async (status: "" | TransferStatus) => {
    setError("");

    try {
      const transferUrl = status ? `/api/transfers?status=${encodeURIComponent(status)}` : "/api/transfers";

      const [accountResponse, transferResponse] = await Promise.all([
        fetch("/api/accounts", { headers }),
        fetch(transferUrl, { headers }),
      ]);

      if (!accountResponse.ok) throw new Error(await getErrorMessage(accountResponse));
      if (!transferResponse.ok) throw new Error(await getErrorMessage(transferResponse));

      const [accountData, transferData] = await Promise.all([accountResponse.json(), transferResponse.json()]);

      setAccounts(accountData);
      setTransfers(transferData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load data");
    }
  }, []);

  useEffect(() => {
    setLoading(true);

    void refresh(statusFilter).finally(() => {
      setLoading(false);
    });
  }, [refresh, statusFilter]);

  async function submit(event: FormEvent) {
    event.preventDefault();

    setMessage("");
    setError("");

    const parsedAmount = Number(amount);

    if (!/^\d{10}$/.test(destinationAccount)) {
      setError("Destination account must contain exactly 10 digits.");
      return;
    }

    if (!Number.isInteger(parsedAmount) || parsedAmount <= 0) {
      setError("Amount must be a positive integer in minor units.");
      return;
    }

    const account = accounts[0];

    if (!account) {
      setError("No debit account is available.");
      return;
    }

    setSending(true);

    try {
      const response = await fetch("/api/transfers", {
        method: "POST",
        headers: {
          ...headers,
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          debitAccountId: account.id,
          destinationAccount,
          amount: parsedAmount,
        }),
      });

      if (!response.ok && response.status !== 202) {
        setError(await getErrorMessage(response));
        return;
      }

      const result = await response.json();

      if (result.status === "uncertain") {
        setMessage("Transfer submitted, but the provider response is uncertain. Reconciliation is required.");
      } else {
        setMessage(`Transfer of NGN ${result.amount} created.`);
      }

      await refresh(statusFilter);
    } catch {
      setError("Unable to create transfer.");
    } finally {
      setSending(false);
    }
  }

  async function reconcile() {
    setReconciling(true);
    setError("");
    setMessage("");

    try {
      const response = await fetch("/api/admin/reconcile", {
        method: "POST",
        headers,
      });

      if (!response.ok) {
        setError(await getErrorMessage(response));
        return;
      }

      const result = await response.json();

      setMessage(
        result.processed > 0
          ? `${result.processed} transfer${result.processed === 1 ? "" : "s"} reconciled.`
          : "No transfers required reconciliation.",
      );

      await refresh(statusFilter);
    } catch {
      setError("Unable to reconcile transfers.");
    } finally {
      setReconciling(false);
    }
  }

  const uncertainCount = transfers.filter((transfer) => transfer.status === "uncertain").length;

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">RelayPay</p>
          <h1>Transfer operations</h1>
          <p className="muted">Monitor transfers and resolve provider uncertainty.</p>
        </div>

        <span className="environment">Local sandbox</span>
      </header>

      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}

      {message && (
        <div className="alert message" role="status">
          {message}
        </div>
      )}

      <section className="grid">
        <article className="card balance">
          <p className="label">Available balance</p>

          {loading ? <strong>Loading...</strong> : <strong>{money.format((accounts[0]?.balance ?? 0) / 100)}</strong>}

          <p className="muted">{accounts[0]?.id ?? "Loading account..."}</p>
        </article>

        <form className="card" onSubmit={submit}>
          <h2>New transfer</h2>

          <label>
            Destination account
            <input
              value={destinationAccount}
              onChange={(event) => setDestinationAccount(event.target.value)}
              inputMode="numeric"
              maxLength={10}
              disabled={sending}
            />
          </label>

          <label>
            Amount in minor units
            <input
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="numeric"
              disabled={sending}
            />
          </label>

          <button type="submit" disabled={!accounts.length || sending || loading}>
            {sending ? "Sending..." : "Send transfer"}
          </button>
        </form>
      </section>

      <section className="card transfers">
        <div className="section-heading">
          <div>
            <p className="label">Activity</p>
            <h2>Transfers</h2>
          </div>

          <div className="actions">
            <button
              className="secondary"
              onClick={() => void refresh(statusFilter)}
              disabled={loadingTransfers || reconciling}
            >
              Refresh
            </button>

            <button className="secondary" onClick={() => void reconcile()} disabled={reconciling}>
              {reconciling ? "Reconciling..." : "Reconcile"}
            </button>
          </div>
        </div>

        <div className="operations-summary">
          <span>
            {uncertainCount > 0
              ? `${uncertainCount} transfer${uncertainCount === 1 ? "" : "s"} need reconciliation`
              : "No transfers currently need reconciliation"}
          </span>
        </div>

        <div className="filters">
          {statusOptions.map((option) => (
            <button
              key={option.value}
              className={statusFilter === option.value ? "filter active" : "filter"}
              onClick={() => setStatusFilter(option.value)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>

        {loading || loadingTransfers ? (
          <p className="empty">Loading transfers...</p>
        ) : transfers.length === 0 ? (
          <p className="empty">{statusFilter ? `No ${statusFilter} transfers found.` : "No transfers yet."}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Destination</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>

            <tbody>
              {transfers.map((transfer) => (
                <tr key={transfer.id}>
                  <td>{transfer.destinationAccount}</td>

                  <td>{money.format(transfer.amount / 100)}</td>

                  <td>
                    <span className={`status ${transfer.status}`}>
                      {transfer.status === "uncertain" ? "Needs reconciliation" : transfer.status}
                    </span>
                  </td>

                  <td>{new Date(transfer.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
