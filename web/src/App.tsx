import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BootstrapResponse,
  DinnerView,
  MutationEnvelope,
  PreferencesInput,
} from "../../src/miniapp/contracts";
import { ApiError, friendlyError, MiniAppApi } from "./api";
import { Brand, Button, Field, Icon, Notice, Sheet } from "./components";
import { AnswersPreview, type ManualAnswers } from "./AnswersPreview";
import { CreateDinner } from "./CreateDinner";
import { Dashboard } from "./Dashboard";
import { PreferencesForm, type ResponseContext } from "./PreferencesForm";
import { applyTelegramTheme, getTelegram, invitationToken } from "./telegram";
import { dateLabel } from "./time";

type Screen = "home" | "create" | "dashboard" | "response" | "shared";
interface ResponseDraft {
  context: ResponseContext;
  initial?: DinnerView["own"]["constraints"];
  foodConfirmed?: boolean;
  answerSharing?: boolean;
  formVersion?: string;
  dinnerId: string;
  invite?: string;
}
function OpenInTelegram({ deleted = false }: { deleted?: boolean }) {
  const [username, setUsername] = useState(""),
    [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    setFailed(false);
    void fetch("/api/miniapp/public", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error();
        return response.json();
      })
      .then((value) => {
        if (!/^[A-Za-z0-9_]{5,32}$/.test(value.botUsername)) throw new Error();
        setUsername(value.botUsername);
      })
      .catch(() => setFailed(true));
  }, []);
  useEffect(load, [load]);
  return (
    <>
      <Brand />
      <main className="page landing">
        <div className="table-illustration large" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <div>✳</div>
        </div>
        <div className="eyebrow">Less planning. More together.</div>
        <h1>
          {deleted ? (
            <>
              Your data
              <br />
              is deleted.
            </>
          ) : (
            <>
              A good dinner
              <br />
              starts here.
            </>
          )}
        </h1>
        <p className="intro">
          {deleted
            ? "Your personal data and organizer dinners have been removed. To join again, open the bot and send /start."
            : "Muse brings your friends' availability and preferences into one plan everyone agrees to."}
        </p>
        <div className="card form-card">
          <h2>Open Muse in Telegram</h2>
          <p className="muted">
            Your dinner lives in your private Telegram Mini App. Open the bot to
            get started securely.
          </p>
          {username ? (
            <a
              className="button button-primary full"
              href={`https://t.me/${username}`}
              rel="noopener noreferrer"
            >
              Open Muse in Telegram <Icon name="arrow" />
            </a>
          ) : failed ? (
            <Button variant="secondary" className="full" onClick={load}>
              Try loading the Telegram link again
            </Button>
          ) : (
            <p role="status" className="muted">
              Finding your Telegram link…
            </p>
          )}
        </div>
        <p className="footnote">
          No private dinner details are loaded outside Telegram.
        </p>
      </main>
    </>
  );
}
export function App() {
  const [telegram] = useState(getTelegram);
  const [api] = useState(() =>
    telegram ? new MiniAppApi(telegram.initData) : null,
  );
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>();
  const [dinner, setDinner] = useState<DinnerView>();
  const [screen, setScreen] = useState<Screen>("home");
  const [deleted, setDeleted] = useState(false);
  const [sharedDraft, setSharedDraft] = useState<{
    setup: DinnerView["setup"];
    version: string;
  }>();
  const [response, setResponse] = useState<ResponseDraft>();
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [sharingPreview, setSharingPreview] = useState<{
    answers: ManualAnswers;
    formVersion: string;
    timezone: string;
    currency: string;
  }>();
  const [sharingConfirmed, setSharingConfirmed] = useState(false);
  const [settings, setSettings] = useState(false),
    [danger, setDanger] = useState<"stop" | "delete" | "cancelDinner" | null>(
      null,
    );
  const epoch = useRef(0),
    activeDinner = useRef<string | undefined>(undefined);
  const invite = useRef(invitationToken()).current;
  const previousDinnerStatus = useRef<string | undefined>(undefined);
  useEffect(() => {
    const previous = previousDinnerStatus.current;
    previousDinnerStatus.current = dinner?.status;
    // Only an active-to-cancelled transition interrupts an editor. Loading an
    // already cancelled dinner must leave its privacy settings available.
    if (
      dinner?.status !== "cancelled" ||
      previous === undefined ||
      previous === "cancelled"
    )
      return;
    setScreen("dashboard");
    setResponse(undefined);
    setSharedDraft(undefined);
    setSettings(false);
    setDanger(null);
  }, [dinner?.status]);
  useEffect(() => {
    if (!telegram) return;
    telegram.ready();
    telegram.expand();
    applyTelegramTheme(telegram);
    const update = () => applyTelegramTheme(telegram);
    telegram.onEvent?.("themeChanged", update);
    return () => telegram.offEvent?.("themeChanged", update);
  }, [telegram]);
  const load = useCallback(async () => {
    if (!api) return;
    setLoading(true);
    setError("");
    try {
      const next = await api.bootstrap(invite);
      setBootstrap(next);
      const query = new URLSearchParams(window.location.search);
      if (query.get("view") === "create") {
        setScreen("create");
        return;
      }
      const requestedDinner = query.get("dinner") ?? next.currentDinnerId;
      if (
        requestedDinner &&
        (!next.invitation ||
          next.invitation.alreadyJoined ||
          query.has("dinner"))
      ) {
        const view = await api.dinner(requestedDinner);
        setDinner(view);
        activeDinner.current = view.id;
        setScreen("dashboard");
      }
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setLoading(false);
    }
  }, [api, invite]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!api || !dinner?.id) return;
    const id = dinner.id;
    async function refresh() {
      if (document.visibilityState !== "visible" || busy) return;
      const version = epoch.current;
      try {
        const next = await api!.dinner(id);
        if (version === epoch.current && activeDinner.current === id)
          setDinner(next);
      } catch {
        /* Poll failures leave the last known state; explicit actions report actionable errors. */
      }
    }
    const timer = window.setInterval(() => void refresh(), 5000);
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [api, dinner?.id, busy]);
  function edit(view: DinnerView) {
    setError("");
    setResponse({
      context: { ...view.setup },
      initial: view.own.constraints,
      foodConfirmed: view.own.foodConfirmed,
      answerSharing: view.own.answerSharing,
      formVersion: view.formVersion,
      dinnerId: view.id,
    });
    setScreen("response");
  }
  async function openDinner(id: string) {
    if (!api) return;
    setBusy(true);
    setError("");
    epoch.current++;
    try {
      const view = await api.dinner(id);
      setDinner(view);
      activeDinner.current = id;
      setScreen("dashboard");
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setBusy(false);
    }
  }
  const mutate = async (
    input: Omit<MutationEnvelope, "requestId">,
  ): Promise<boolean> => {
    if (!api || busy) return false;
    setBusy(true);
    setError("");
    setNotice("");
    epoch.current++;
    try {
      const result = await api.action(input);
      if (result.dinner) {
        const view = result.dinner;
        setDinner(view);
        activeDinner.current = view.id;
        setBootstrap((current) =>
          current
            ? {
                ...current,
                currentDinnerId: view.id,
                dinners: [
                  ...current.dinners.filter((item) => item.id !== view.id),
                  {
                    id: view.id,
                    city: view.city,
                    windowStart: view.windowStart,
                    windowEnd: view.windowEnd,
                    status: view.status,
                    role: view.role,
                    ended: view.ended,
                  },
                ],
                ...(current.invitation?.dinnerId === view.id
                  ? {
                      invitation: {
                        ...current.invitation,
                        alreadyJoined: true,
                        pending: view.role === "pending",
                      },
                    }
                  : {}),
              }
            : current,
        );
      }
      if (result.message) setNotice(result.message);
      if (result.invitationUrl)
        telegram?.openTelegramLink(
          `https://t.me/share/url?url=${encodeURIComponent(result.invitationUrl)}&text=${encodeURIComponent("Come to dinner with us. Choose your own dates and preferences in Muse.")}`,
        );
      if (result.calendarUrl) telegram?.openLink(result.calendarUrl);
      if (result.deleted) {
        setDinner(undefined);
        activeDinner.current = undefined;
        setSettings(false);
        setDanger(null);
        setBootstrap(undefined);
        setResponse(undefined);
        setSharedDraft(undefined);
        setSharingPreview(undefined);
        setSharingConfirmed(false);
        setDeleted(true);
      } else if (input.action === "stop") {
        setSettings(false);
        setDanger(null);
        setScreen("home");
        setBootstrap(await api.bootstrap());
      }
      return true;
    } catch (failure) {
      setError(friendlyError(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const dinnerAction = (
    action: MutationEnvelope["action"],
    payload?: unknown,
  ) =>
    mutate({
      action,
      dinnerId: dinner?.id,
      formVersion: dinner?.formVersion,
      payload,
    });
  async function savePreferences(preferences: PreferencesInput) {
    if (!response) return;
    const success = await mutate({
      action: response.invite ? "join" : "savePreferences",
      dinnerId: response.dinnerId,
      formVersion: response.formVersion,
      payload: response.invite
        ? { invite: response.invite, consent: true, preferences }
        : preferences,
    });
    if (success) {
      setScreen("dashboard");
      setResponse(undefined);
    }
  }
  async function exportCalendar() {
    if (!api || !dinner) return;
    setBusy(true);
    setError("");
    try {
      const blob = await api.calendar(dinner.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "dinner.ics";
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(
        "Your calendar file is ready. Open it to add the agreed dinner.",
      );
    } catch (failure) {
      setError(friendlyError(failure));
    } finally {
      setBusy(false);
    }
  }
  if (deleted) return <OpenInTelegram deleted />;
  if (!telegram) return <OpenInTelegram />;
  if (loading)
    return (
      <>
        <Brand />
        <main className="page loading-page">
          <div className="spinner" />
          <p>Setting your table…</p>
        </main>
      </>
    );
  if (!bootstrap)
    return (
      <>
        <Brand />
        <main className="page">
          <h1>Let's reconnect.</h1>
          <Notice kind="error">
            {error || "Your dinner could not be loaded."}
          </Notice>
          <Button onClick={() => void load()}>Try again</Button>
        </main>
      </>
    );
  if (screen === "create")
    return (
      <CreateDinner
        onBack={() => setScreen("home")}
        busy={busy}
        error={error}
        onCreate={async (input) => {
          if (!api) return;
          setBusy(true);
          setError("");
          epoch.current++;
          try {
            const result = await api.action({
              action: "create",
              payload: input,
            });
            if (result.dinner) {
              setDinner(result.dinner);
              activeDinner.current = result.dinner.id;
              edit(result.dinner);
              setBootstrap((current) =>
                current
                  ? {
                      ...current,
                      currentDinnerId: result.dinner!.id,
                      dinners: [
                        ...current.dinners.filter(
                          (item) => item.id !== result.dinner!.id,
                        ),
                        result.dinner!,
                      ],
                    }
                  : current,
              );
            }
          } catch (failure) {
            setError(friendlyError(failure));
          } finally {
            setBusy(false);
          }
        }}
      />
    );
  if (screen === "shared" && dinner && sharedDraft)
    return (
      <CreateDinner
        key={`shared-${dinner.id}-${sharedDraft.version}`}
        initial={sharedDraft.setup}
        editing
        onBack={() => setScreen("dashboard")}
        busy={busy}
        error={error}
        onCreate={async (input) => {
          const { partySize: _party, consent: _consent, ...payload } = input;
          if (
            await mutate({
              action: "updateDinner",
              dinnerId: dinner.id,
              formVersion: sharedDraft.version,
              payload,
            })
          )
            setScreen("dashboard");
        }}
      />
    );
  if (screen === "response" && response)
    return (
      <PreferencesForm
        key={`${response.dinnerId}-${response.formVersion}`}
        context={response.context}
        initial={response.initial}
        foodConfirmed={response.foodConfirmed}
        answerSharing={response.answerSharing}
        needsConsent={!!response.invite}
        busy={busy}
        error={error}
        onBack={() => {
          setError("");
          setScreen(dinner ? "dashboard" : "home");
        }}
        onSave={savePreferences}
      />
    );
  if (screen === "dashboard" && dinner)
    return (
      <>
        <Dashboard
          dinner={dinner}
          actorId={bootstrap.actor.id}
          busy={busy}
          error={error}
          notice={notice}
          onHome={() => {
            setScreen("home");
            setError("");
          }}
          onEdit={() => edit(dinner)}
          onSettings={() => setSettings(true)}
          onAction={dinnerAction}
          onCalendar={exportCalendar}
        />
        {settings && (
          <Sheet
            title="Your dinner settings"
            onClose={() => {
              setSettings(false);
              setDanger(null);
              setSharingPreview(undefined);
              setSharingConfirmed(false);
            }}
          >
            <div className="form-stack">
              <p className="muted">
                {dinner.city} · {dateLabel(dinner.windowStart)}–
                {dateLabel(dinner.windowEnd)}
              </p>
              {sharingPreview ? (
                <section
                  className="form-stack"
                  aria-label="Confirm answer sharing"
                >
                  <h2>Share these answers?</h2>
                  <p className="muted small">
                    Approved members of this dinner will see all the answers
                    below, including your travel starting point. Calendar busy
                    times and private chats are excluded.
                  </p>
                  <AnswersPreview
                    answers={sharingPreview.answers}
                    timezone={sharingPreview.timezone}
                    currency={sharingPreview.currency}
                  />
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={sharingConfirmed}
                      onChange={(event) =>
                        setSharingConfirmed(event.target.checked)
                      }
                    />
                    <span>
                      I want approved members to see exactly these answers.
                    </span>
                  </label>
                  <Button
                    busy={busy}
                    disabled={!sharingConfirmed}
                    onClick={async () => {
                      if (
                        await mutate({
                          action: "setAnswerSharing",
                          dinnerId: dinner.id,
                          formVersion: sharingPreview.formVersion,
                          payload: { enabled: true },
                        })
                      ) {
                        setSharingPreview(undefined);
                        setSharingConfirmed(false);
                      }
                    }}
                  >
                    Share my answers
                  </Button>
                  <Button
                    variant="quiet"
                    onClick={() => {
                      setSharingPreview(undefined);
                      setSharingConfirmed(false);
                    }}
                  >
                    Keep answers private
                  </Button>
                </section>
              ) : danger ? (
                <>
                  <Notice kind={danger === "delete" ? "error" : "info"}>
                    {danger === "delete"
                      ? "Delete all your Muse data, across every dinner? Any dinners you organize will also be deleted. This cannot be undone."
                      : danger === "cancelDinner"
                        ? "Cancel this dinner for everyone? Planning and reminders will stop, and this dinner cannot be reopened. Any reservation or exported calendar event must be cancelled manually."
                        : "Stop dinner coordination? Muse will stop planning messages for you. You can explicitly resume later."}
                  </Notice>
                  <Button
                    variant="danger"
                    busy={busy}
                    onClick={async () => {
                      if (
                        await dinnerAction(
                          danger,
                          danger === "cancelDinner"
                            ? { confirmed: true }
                            : undefined,
                        )
                      ) {
                        setDanger(null);
                        setSettings(false);
                      }
                    }}
                  >
                    {danger === "delete"
                      ? "Delete all my Muse data"
                      : danger === "cancelDinner"
                        ? "Yes, cancel this dinner"
                        : "Stop coordination"}
                  </Button>
                  <Button variant="quiet" onClick={() => setDanger(null)}>
                    {danger === "cancelDinner"
                      ? "Keep dinner planned"
                      : "Keep my place"}
                  </Button>
                </>
              ) : (
                <>
                  {dinner.role === "organizer" &&
                    !dinner.ended &&
                    dinner.status !== "cancelled" && (
                      <>
                        <Button
                          variant="secondary"
                          onClick={() => {
                            setSharedDraft({
                              setup: dinner.setup,
                              version: dinner.formVersion,
                            });
                            setSettings(false);
                            setError("");
                            setScreen("shared");
                          }}
                        >
                          Edit shared dinner details
                        </Button>
                        <div className="divider" />
                      </>
                    )}
                  {dinner.status === "cancelled" ? (
                    <Notice>
                      This dinner is cancelled. Any restaurant reservation or
                      calendar event must be cancelled manually. Muse has not
                      changed those for you.
                    </Notice>
                  ) : (
                    <>
                      {" "}
                      <section className="settings-section">
                        <div className="section-icon">
                          <Icon name="calendar" />
                          <h3>Your calendar</h3>
                        </div>
                        <p className="muted small">
                          Optional. Muse checks busy times; a free calendar is
                          never treated as a yes.
                        </p>
                        {dinner.own.calendar === "not-connected" ? (
                          <Button
                            variant="secondary"
                            busy={busy}
                            onClick={() => void dinnerAction("calendarConnect")}
                          >
                            Connect Google Calendar
                          </Button>
                        ) : dinner.own.calendar === "staged" ? (
                          <>
                            <Notice>
                              Your calendar is authorized. Activate it for this
                              dinner when you're ready.
                            </Notice>
                            <Button
                              busy={busy}
                              onClick={() =>
                                void dinnerAction("calendarActivate")
                              }
                            >
                              Use calendar for this dinner
                            </Button>
                            <Button
                              variant="quiet"
                              busy={busy}
                              onClick={() =>
                                void dinnerAction("calendarDisconnect")
                              }
                            >
                              Disconnect
                            </Button>
                          </>
                        ) : (
                          <>
                            <p className="status-badge">
                              {dinner.own.calendar === "connected"
                                ? "Connected for this dinner"
                                : "Calendar needs attention"}
                            </p>
                            <div className="choice-row">
                              <Button
                                variant="secondary"
                                busy={busy}
                                onClick={() =>
                                  void dinnerAction("calendarSync")
                                }
                              >
                                Refresh busy times
                              </Button>
                              <Button
                                variant="quiet"
                                busy={busy}
                                onClick={() =>
                                  void dinnerAction("calendarDisconnect")
                                }
                              >
                                Disconnect
                              </Button>
                            </div>
                          </>
                        )}
                      </section>
                      <div className="divider" />
                      <label className="toggle-label">
                        <span>
                          <strong>Gentle reminders</strong>
                          <small>
                            At most once a day, outside quiet hours.
                          </small>
                        </span>
                        <input
                          type="checkbox"
                          role="switch"
                          checked={dinner.own.reminders}
                          disabled={busy}
                          onChange={(e) =>
                            void dinnerAction("reminders", {
                              enabled: e.target.checked,
                            })
                          }
                        />
                      </label>
                      <div className="divider" />
                      <Button variant="quiet" onClick={() => setDanger("stop")}>
                        Stop coordination for me
                      </Button>
                      {dinner.role === "organizer" &&
                        !dinner.ended &&
                        dinner.status !== "cancelled" && (
                          <Button
                            variant="danger"
                            onClick={() => setDanger("cancelDinner")}
                          >
                            Cancel dinner for everyone
                          </Button>
                        )}
                    </>
                  )}
                  <section
                    className="settings-section"
                    aria-label="Answer sharing settings"
                  >
                    <h3>Your answer sharing</h3>
                    <p className="muted small">
                      {dinner.own.answerSharing
                        ? "Your manual form answers are shared with approved dinner members."
                        : "Your answers are private. Only the shared dinner plan and progress are visible to others."}
                    </p>
                    {dinner.own.answerSharing ? (
                      <>
                        <Button
                          variant="secondary"
                          busy={busy}
                          onClick={() =>
                            void mutate({
                              action: "setAnswerSharing",
                              dinnerId: dinner.id,
                              payload: { enabled: false },
                            })
                          }
                        >
                          Make my answers private
                        </Button>
                        <p className="field-hint">
                          This stops future sharing. It cannot remove copies
                          already seen.
                        </p>
                      </>
                    ) : (dinner.role === "organizer" ||
                        dinner.role === "member") &&
                      dinner.own.consent &&
                      !dinner.ended &&
                      dinner.status !== "cancelled" ? (
                      <>
                        <Button
                          variant="secondary"
                          disabled={
                            !dinner.own.foodConfirmed ||
                            !dinner.own.constraints.availability?.length
                          }
                          onClick={() => {
                            setSharingPreview({
                              answers: structuredClone(dinner.own.constraints),
                              formVersion: dinner.formVersion,
                              timezone: dinner.setup.timezone,
                              currency: dinner.setup.currency,
                            });
                            setSharingConfirmed(false);
                            setError("");
                          }}
                        >
                          Review &amp; share my answers
                        </Button>
                        {(!dinner.own.foodConfirmed ||
                          !dinner.own.constraints.availability?.length) && (
                          <p className="field-hint">
                            Save your own answers before choosing to share them.
                          </p>
                        )}
                      </>
                    ) : null}
                    <p className="field-hint">
                      Calendar busy times, private chats and staff conversations
                      are never shared. Sharing can be turned off even after
                      this dinner ends.
                    </p>
                  </section>
                  <div className="divider" />
                  <Button variant="danger" onClick={() => setDanger("delete")}>
                    Delete all my Muse data
                  </Button>
                  <div className="legal-links">
                    <a
                      href={bootstrap.privacyUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Privacy
                    </a>
                    <span>{bootstrap.supportContact}</span>
                  </div>
                </>
              )}
              {error && <Notice kind="error">{error}</Notice>}
            </div>
          </Sheet>
        )}
      </>
    );
  const invitation = bootstrap.invitation;
  return (
    <>
      <Brand />
      <main className="page">
        <div className="eyebrow">
          Hello, {bootstrap.actor.name.split(" ")[0]}
        </div>
        <h1>
          Good evenings
          <br />
          start together.
        </h1>
        <p className="intro">A little coordination. A lot more catching up.</p>
        {error && <Notice kind="error">{error}</Notice>}
        {invitation && !invitation.alreadyJoined && (
          <section className="card invitation-card">
            <span className="eyebrow">You're invited</span>
            <h2>Dinner in {invitation.city}</h2>
            <p className="muted">
              {dateLabel(invitation.windowStart)}–
              {dateLabel(invitation.windowEnd)} · {invitation.partySize} at the
              table
            </p>
            <p className="small">
              Add your own availability and food requirements. The organizer
              will approve your place.
            </p>
            <Button
              className="full"
              disabled={invitation.availablePlaces <= 0 && !invitation.pending}
              onClick={() => {
                setError("");
                setResponse({
                  context: { ...invitation },
                  dinnerId: invitation.dinnerId,
                  formVersion: invitation.formVersion,
                  invite,
                });
                setScreen("response");
              }}
            >
              Add my answers <Icon name="arrow" />
            </Button>
          </section>
        )}
        <button
          className="new-dinner-card"
          onClick={() => {
            setError("");
            setScreen("create");
          }}
        >
          <span className="new-dinner-icon">
            <Icon name="plus" size={26} />
          </span>
          <span>
            <strong>Start a dinner</strong>
            <small>Bring 2–6 people to the table.</small>
          </span>
          <Icon name="arrow" />
        </button>
        {bootstrap.dinners.length > 0 && (
          <section className="dinner-list">
            <h2>Your dinners</h2>
            {bootstrap.dinners.map((item) => (
              <button
                key={item.id}
                className="card dinner-list-item"
                disabled={busy}
                onClick={() => void openDinner(item.id)}
              >
                <div className="date-tile">
                  <Icon name="calendar" size={22} />
                </div>
                <div>
                  <h3>{item.city}</h3>
                  <p>
                    {dateLabel(item.windowStart)}–{dateLabel(item.windowEnd)}
                  </p>
                  <span className="small muted">
                    {item.status === "cancelled"
                      ? "Cancelled"
                      : item.role === "pending"
                        ? "Waiting for approval"
                        : item.status === "agreed"
                          ? "Agreed plan"
                          : item.ended
                            ? "Dinner has begun"
                            : "Planning together"}
                  </span>
                </div>
                <Icon name="chevron" />
              </button>
            ))}
          </section>
        )}
        <div className="home-note">
          <Icon name="leaf" size={20} />
          <p>
            Everyone has a say.
            <br />
            Muse helps turn it into a plan.
          </p>
        </div>
        <div className="legal-links">
          <a
            href={bootstrap.privacyUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Privacy
          </a>
          <span>{bootstrap.supportContact}</span>
        </div>
      </main>
    </>
  );
}
