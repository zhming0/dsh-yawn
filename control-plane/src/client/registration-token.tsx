import { useEffect, useState } from "react";

import { Button } from "@deepseek-ai/dsh-client-ui-primitives";

import {
  cardStyle,
  describeError,
  sectionHeadingStyle,
  type RegistrationTokenActions,
} from "./settings-shared.js";
import type { RegistrationTokenView } from "../registration-token.js";

/**
 * The tunnel credential, on the Sandboxes page. The control plane generates
 * it and hands it to every runner it starts; this card exists for the operator
 * who has to configure a runner the control plane does not start, and for
 * replacing the token without dropping live sandboxes.
 */
export function RegistrationTokenCard({
  getRegistrationToken,
  rotateRegistrationToken,
  retireRegistrationToken,
}: RegistrationTokenActions) {
  const [view, setView] = useState<RegistrationTokenView>();
  const [revealed, setRevealed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    getRegistrationToken().then(setView, (reason) =>
      setError(describeError(reason)),
    );
  }, [getRegistrationToken]);

  const run = async (
    action: () => Promise<RegistrationTokenView>,
    note: string,
  ) => {
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    try {
      setView(await action());
      setNotice(note);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setPending(false);
    }
  };

  return (
    <div style={{ ...cardStyle, marginTop: 16 }}>
      <h3 style={sectionHeadingStyle}>Runner token</h3>
      <p
        style={{
          margin: "0 0 12px",
          color: "var(--dsw-alias-label-secondary)",
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        Every runner proves itself with this token when it dials the tunnel. The
        control plane generates it and gives it to the sandboxes it starts; copy
        it from here only for a runner you start yourself. Rotating makes a new
        token current; sandboxes that already booted keep the old one until you
        retire it.
      </p>

      {view === undefined && error === undefined ? (
        <p style={{ margin: 0, color: "var(--dsw-alias-label-secondary)" }}>
          Loading…
        </p>
      ) : null}

      {view !== undefined ? (
        <>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <code
              style={{
                flex: 1,
                minWidth: 0,
                overflowWrap: "anywhere",
                fontSize: 13,
              }}
            >
              {revealed ? view.current : "•".repeat(32)}
            </code>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setRevealed((current) => !current)}
            >
              {revealed ? "Hide" : "Show"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="primary"
              disabled={pending}
              onClick={() =>
                void run(rotateRegistrationToken, "rotated the runner token")
              }
            >
              Rotate
            </Button>
          </div>

          {view.retiring.length > 0 ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                marginTop: 10,
              }}
            >
              <span
                style={{
                  color: "var(--dsw-alias-label-secondary)",
                  fontSize: 13,
                }}
              >
                {view.retiring.length === 1
                  ? "The previous token is still accepted."
                  : `${view.retiring.length} previous tokens are still accepted.`}{" "}
                Retire them once the sandboxes holding them are gone.
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  void run(
                    retireRegistrationToken,
                    "retired the previous runner tokens",
                  )
                }
              >
                Retire previous
              </Button>
            </div>
          ) : null}
        </>
      ) : null}

      {notice !== undefined ? (
        <p
          style={{
            margin: "10px 0 0",
            color: "var(--dsw-alias-label-secondary)",
            fontSize: 13,
          }}
        >
          {notice}
        </p>
      ) : null}
      {error !== undefined ? (
        <p
          role="alert"
          style={{
            margin: "10px 0 0",
            color: "var(--dsw-alias-state-error-primary)",
            fontSize: 13,
          }}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
