import { useState } from "react";
import { field, primary, zh } from "./presentation.js";

export function EnterpriseLogin({
  t,
  busy,
  onLogin,
}: {
  t: typeof zh;
  busy: boolean;
  onLogin: (email: string, password: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <form
        className="flex w-full max-w-sm flex-col gap-3 rounded-xl border border-card-border bg-card p-5"
        onSubmit={(event) => {
          event.preventDefault();
          onLogin(email, password);
          setPassword("");
        }}
      >
        <h1 className="text-ui-xl font-medium">{t.login}</h1>
        <label className="flex flex-col gap-1 text-ui-caption">
          {t.email}
          <input
            className={field}
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-ui-caption">
          {t.password}
          <input
            className={field}
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <button className={primary} disabled={busy}>
          {t.login}
        </button>
      </form>
    </main>
  );
}
