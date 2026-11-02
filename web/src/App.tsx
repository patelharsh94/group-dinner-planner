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
import { DinnerList } from "./DinnerList";
import { dinnerName, dinnerSummary, ownedActiveCount } from "./dinners";
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
  const [renameDraft, setRenameDraft] = useState<{
    dinnerId: string;
    title: string;
    formVersion: string;
  }>();
  const [openingId, setOpeningId] = useState<string>();
  const choiceQueue = useRef<Promise<void>>(Promise.resolve());
  const viewRequest = useRef(0),
    homeRequest = useRef(0);
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
    setSharingPreview(undefined);
    setSharingConfirmed(false);
    setRenameDraft(undefined);
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
  function clearTransients() {
    setResponse(undefined);
    setSharedDraft(undefined);
    setSettings(false);
    setDanger(null);
    setSharingPreview(undefined);
    setSharingConfirmed(false);
    setRenameDraft(undefined);
    setError("");
    setNotice("");
  }
  function navigate(next: Screen): number {
    const version = ++epoch.current;
    viewRequest.current++;
    homeRequest.current++;
    activeDinner.current = undefined;
    previousDinnerStatus.current = undefined;
    setDinner(undefined);
    clearTransients();
    setBusy(false);
    setOpeningId(undefined);
    setScreen(next);
    return version;
  }
  function acceptView(view: DinnerView) {
    setDinner(view);
    activeDinner.current = view.id;
    setBootstrap((current) =>
      current
        ? {
            ...current,
            currentDinnerId: view.id,
            dinners: [
              ...current.dinners.filter((item) => item.id !== view.id),
              dinnerSummary(view),
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
  function requestChoice(id: string, version: number) {
    const request = choiceQueue.current.then(() =>
      version === epoch.current
        ? api!.action({ action: "chooseDinner", dinnerId: id })
        : undefined,
    );
    choiceQueue.current = request.then(
      () => undefined,
      () => undefined,
    );
    return request;
  }
  async function refreshHome(version = epoch.current, preserveInvite = false) {
    if (!api) return;
    const request = ++homeRequest.current;
    try {
      const next = await api.bootstrap(preserveInvite ? invite : undefined);
      if (
        version === epoch.current &&
        request === homeRequest.current &&
        activeDinner.current === undefined
      )
        setBootstrap(next);
    } catch (failure) {
      if (version === epoch.current && request === homeRequest.current)
        setError(friendlyError(failure));
    }
  }
  function goHome(preserveInvite = false) {
    const version = navigate("home");
    void refreshHome(version, preserveInvite);
  }
  const load = useCallback(async () => {
    if (!api) return;
    const version = ++epoch.current;
    viewRequest.current++;
    setLoading(true);
    setError("");
    activeDinner.current = undefined;
    try {
      const next = await api.bootstrap(invite);
      if (version !== epoch.current) return;
      setBootstrap(next);
      const query = new URLSearchParams(window.location.search);
      if (query.get("view") === "create") {
        if (
          ownedActiveCount(next.dinners) >=
          (next.maxActiveDinnersPerOrganizer ?? 5)
        ) {
          setScreen("home");
          setError(
            "You have reached the active dinner limit. Cancel a dinner or wait for one to finish before starting another.",
          );
        } else setScreen("create");
        return;
      }
      const explicit =
        query.get("dinner") ??
        (invite && next.invitation?.alreadyJoined
          ? next.invitation.dinnerId
          : null);
      const ongoing = next.dinners.filter((item) => !item.ended);
      const requested =
        explicit ??
        (!invite && ongoing.length < 2
          ? (ongoing[0]?.id ?? next.currentDinnerId)
          : null);
      if (!requested) {
        setScreen("home");
        return;
      }
      const persist = !!explicit || requested !== next.currentDinnerId;
      const result = persist
        ? (await requestChoice(requested, version))?.dinner
        : await api.dinner(requested);
      if (version !== epoch.current || !result) return;
      acceptView(result);
      setScreen("dashboard");
    } catch (failure) {
      if (version === epoch.current) setError(friendlyError(failure));
    } finally {
      if (version === epoch.current) setLoading(false);
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
      const version = epoch.current,
        request = ++viewRequest.current;
      try {
        const next = await api!.dinner(id);
        if (
          version === epoch.current &&
          request === viewRequest.current &&
          activeDinner.current === id
        )
          acceptView(next);
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
  useEffect(() => {
    if (!api || screen !== "home" || !bootstrap) return;
    const preserve =
      !!bootstrap.invitation && !bootstrap.invitation.alreadyJoined;
    const refresh = () => {
      if (document.visibilityState === "visible")
        void refreshHome(epoch.current, preserve);
    };
    const timer = window.setInterval(refresh, 5000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [api, screen, !!bootstrap, bootstrap?.invitation?.alreadyJoined]);
  async function openDinner(id: string) {
    if (!api) return;
    const version = navigate("home");
    setBusy(true);
    setOpeningId(id);
    try {
      const result = await requestChoice(id, version);
      if (version !== epoch.current || !result?.dinner) return;
      acceptView(result.dinner);
      setScreen("dashboard");
    } catch (failure) {
      if (version === epoch.current) setError(friendlyError(failure));
    } finally {
      if (version === epoch.current) {
        setBusy(false);
        setOpeningId(undefined);
      }
    }
  }
  const mutate = async (
    input: Omit<MutationEnvelope, "requestId">,
  ): Promise<boolean> => {
    if (!api || busy) return false;
    setBusy(true);
    setError("");
    setNotice("");
    const version = ++epoch.current;
    viewRequest.current++;
    try {
      const result = await api.action(input);
      if (
        version !== epoch.current &&
        !result.deleted &&
        input.action !== "stop"
      )
        return false;
      if (result.dinner) acceptView(result.dinner);
      if (result.message) setNotice(result.message);
      if (result.invitationUrl)
        telegram?.openTelegramLink(
          `https://t.me/share/url?url=${encodeURIComponent(result.invitationUrl)}&text=${encodeURIComponent(`Join ${dinner ? dinnerName(dinner) : "our dinner"}. Choose your own dates and preferences in Muse.`)}`,
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
        setRenameDraft(undefined);
        setDeleted(true);
      } else if (input.action === "stop") {
        const homeVersion = navigate("home");
        await refreshHome(homeVersion);
      }
      return true;
    } catch (failure) {
      if (version === epoch.current) setError(friendlyError(failure));
      return false;
    } finally {
      if (version === epoch.current) setBusy(false);
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
    const version = ++epoch.current;
    viewRequest.current++;
    try {
      const blob = await api.calendar(dinner.id);
      if (version !== epoch.current) return;
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
      if (version === epoch.current) setError(friendlyError(failure));
    } finally {
      if (version === epoch.current) setBusy(false);
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
        onBack={() => goHome()}
        busy={busy}
        error={error}
        onCreate={async (input) => {
          if (!api) return;
          setBusy(true);
          setError("");
          const version = ++epoch.current;
          viewRequest.current++;
          try {
            const result = await api.action({
              action: "create",
              payload: input,
            });
            if (version !== epoch.current) return;
            if (result.dinner) {
              acceptView(result.dinner);
              edit(result.dinner);
            }
          } catch (failure) {
            if (version === epoch.current) setError(friendlyError(failure));
          } finally {
            if (version === epoch.current) setBusy(false);
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
          key={dinner.id}
          dinner={dinner}
          actorId={bootstrap.actor.id}
          busy={busy}
          error={error}
          notice={notice}
          onHome={() => goHome()}
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
              setRenameDraft(undefined);
            }}
          >
            <div className="form-stack">
              <p className="muted">
                {dinner.city} · {dateLabel(dinner.windowStart)}–
                {dateLabel(dinner.windowEnd)}
              </p>
              {renameDraft ? (
                <section className="form-stack">
                  <h2>Rename dinner</h2>
                  <Field
                    label="Dinner name"
                    hint="Shared with invitees and dinner members. Leave blank to use the city-based name."
                  >
                    <input
                      aria-label="Dinner name"
                      value={renameDraft.title}
                      onChange={(event) =>
                        setRenameDraft({
                          ...renameDraft,
                          title: event.target.value,
                        })
                      }
                      maxLength={80}
                      placeholder={`Dinner in ${dinner.city}`}
                    />
                  </Field>
                  <p className="field-hint">
                    Changing the name keeps the current plan, confirmations and
                    research.
                  </p>
                  <Button
                    busy={busy}
                    onClick={async () => {
                      if (renameDraft.title.trim().length > 80) {
                        setError(
                          "Choose a dinner name of 80 characters or fewer.",
                        );
                        return;
                      }
                      if (
                        await mutate({
                          action: "renameDinner",
                          dinnerId: renameDraft.dinnerId,
                          formVersion: renameDraft.formVersion,
                          payload: { title: renameDraft.title.trim() },
                        })
                      ) {
                        setRenameDraft(undefined);
                        setSettings(false);
                      }
                    }}
                  >
                    Save dinner name
                  </Button>
                  <Button
                    variant="quiet"
                    onClick={() => setRenameDraft(undefined)}
                  >
                    Keep current name
                  </Button>
                </section>
              ) : sharingPreview ? (
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
                        : "Stop coordination across every dinner? Muse will stop planning messages for you and withdraw your consent across all dinners. Required places remain unresolved until the organizer reviews participation. You can explicitly resume where permitted later."}
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
                            setRenameDraft({
                              dinnerId: dinner.id,
                              title: dinner.title ?? "",
                              formVersion: dinner.formVersion,
                            });
                            setError("");
                          }}
                        >
                          Rename dinner
                        </Button>
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
  const activeOwned = ownedActiveCount(bootstrap.dinners),
    maxActive = bootstrap.maxActiveDinnersPerOrganizer ?? 5;
  const canCreate = activeOwned < maxActive;
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
            <h2 className="dinner-title">{dinnerName(invitation)}</h2>
            <p className="muted">
              {invitation.city} · {dateLabel(invitation.windowStart)}–
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
          disabled={!canCreate}
          onClick={() => navigate("create")}
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
        {!canCreate && (
          <Notice>
            You’ve reached the limit of {maxActive} active dinners. Cancel one
            or wait for a dinner to finish before starting another.
          </Notice>
        )}
        {bootstrap.dinners.length > 0 && (
          <>
            <h2 className="home-dinners-heading">Your dinners</h2>
            <DinnerList
              dinners={bootstrap.dinners}
              openingId={openingId}
              onChoose={(id) => void openDinner(id)}
            />
          </>
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
