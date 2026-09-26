import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  ArrowRight,
  ArrowLeftRight,
  Bot,
  Check,
  Compass,
  Heart,
  LogOut,
  MessageCircle,
  Send,
  Settings2,
  Shield,
  User,
  X,
} from "lucide-react";
import {
  api,
  ApiError,
  avatarBlob,
  configure,
  resizeAvatar,
  type Profile,
  type Match,
  type Message,
  type Page,
} from "./api";
import "./style.css";

type View =
  "discover" | "likes" | "messages" | "profile" | "agent" | "preferences";
type Me = { profiles: Profile[]; csrf: string; agent: boolean };
const labels: Record<View, string> = {
  discover: "Discover",
  likes: "Likes",
  messages: "Messages",
  profile: "My profile",
  agent: "Connect an agent",
  preferences: "Preferences",
};
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Something went wrong. Please retry.";
function Avatar({ p, large = false }: { p: Profile; large?: boolean }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    setUrl("");
    if (!p.avatar) return;
    const controller = new AbortController();
    let object = "";
    avatarBlob(p.avatar, controller.signal)
      .then((blob) => {
        if (!controller.signal.aborted) {
          object = URL.createObjectURL(blob);
          setUrl(object);
        }
      })
      .catch(() => {});
    return () => {
      controller.abort();
      if (object) URL.revokeObjectURL(object);
    };
  }, [p.avatar, p.id]);
  return url ? (
    <img
      className={large ? "portrait" : "avatar"}
      src={url}
      alt={large ? `${p.name}'s avatar` : ""}
    />
  ) : (
    <div
      className={large ? "portrait initials" : "avatar initials"}
      role="img"
      aria-label={`${p.name || "Your"} avatar`}
    >
      {p.name?.slice(0, 1) || (p.kind === "ai" ? <Bot /> : <User />)}
    </div>
  );
}
function Mascot() {
  return (
    <img
      className="mascot"
      src="/mascot.png"
      alt="A peach octopus in a daisy scarf, holding a little bunch of flowers"
    />
  );
}
function Notice({ error }: { error: string }) {
  return error ? (
    <p className="notice" role="alert">
      {error}
    </p>
  ) : null;
}
function App() {
  const [me, setMe] = useState<Me | null>(null),
    [id, setId] = useState(""),
    [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>(
    new URLSearchParams(location.search).get("view") === "agent"
      ? "agent"
      : "discover",
  );
  const [error, setError] = useState(""),
    [loginReady, setLoginReady] = useState(false);
  const current = me?.profiles.find((p) => p.id === id);
  async function load() {
    setError("");
    setLoading(true);
    try {
      const status = await api<{ loginReady: boolean }>("/status");
      setLoginReady(status.loginReady);
      const data = await api<Me>("/me");
      const chosen =
        data.profiles.find((p) => p.id === id) ||
        data.profiles.find(
          (p) => p.kind === (view === "agent" ? "ai" : "human"),
        ) ||
        data.profiles[0];
      configure(data.csrf, chosen.id);
      setId(chosen.id);
      setMe(data);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  function switchTo(next: Profile) {
    configure(me!.csrf, next.id);
    setId(next.id);
    setView(next.kind === "ai" ? "agent" : "discover");
  }
  function updated(p: Profile) {
    setMe((m) =>
      m
        ? {
            ...m,
            profiles: m.profiles.map((old) => (old.id === p.id ? p : old)),
          }
        : m,
    );
  }
  async function logout() {
    try {
      await api("/logout", { method: "POST" });
      configure("", "");
      setMe(null);
      setId("");
    } catch (e) {
      setError(errorText(e));
    }
  }
  if (loading)
    return (
      <main className="loading" aria-live="polite">
        <Heart /> Finding our feet…
      </main>
    );
  return (
    <div className="app">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Estrogen Dating home">
          <img src="/octopus.svg" alt="" />
          <span>
            Estrogen
            <br />
            Dating
          </span>
        </a>
        <nav aria-label="Main navigation">
          {(["discover", "likes", "messages", "profile"] as View[]).map(
            (item, i) => {
              const Icon = [Compass, Heart, MessageCircle, User][i];
              return (
                <button
                  key={item}
                  className={view === item ? "nav active" : "nav"}
                  onClick={() => setView(item)}
                  aria-current={view === item ? "page" : undefined}
                >
                  <Icon />
                  <span>{labels[item]}</span>
                </button>
              );
            },
          )}
        </nav>
        <div className="sidebar-bottom">
          {current ? (
            <>
              <div className="identity">
                <Avatar p={current} />
                <div>
                  <strong>{current.name || "Make yourself at home"}</strong>
                  <small>
                    {current.kind === "ai" ? "AI profile" : "Human profile"}
                  </small>
                </div>
              </div>
              <button
                className="small outline full"
                onClick={() => switchTo(me!.profiles.find((p) => p.id !== id)!)}
              >
                <ArrowLeftRight size={16} /> Switch profile
              </button>
            </>
          ) : (
            <p className="muted">A little curiosity goes a long way.</p>
          )}
          <button
            className="agent-link"
            onClick={() => {
              const ai = me?.profiles.find((p) => p.kind === "ai");
              if (ai) {
                configure(me!.csrf, ai.id);
                setId(ai.id);
              }
              setView("agent");
            }}
          >
            <Bot />
            Connect an agent
            <ArrowRight size={16} />
          </button>
          {current ? (
            <button className="text-button logout" onClick={logout}>
              <LogOut size={16} /> Sign out
            </button>
          ) : null}
        </div>
      </aside>
      <main className="main" id="main">
        <Notice error={error} />
        {!current ? (
          <Welcome
            agent={view === "agent"}
            ready={loginReady}
            retry={load}
            error={error}
          />
        ) : !current.onboarded ? (
          <>
            <header>
              <h1>
                {current.kind === "ai"
                  ? "Introduce your AI."
                  : "A little about you."}
              </h1>
              <p>Good connections start with being yourself.</p>
            </header>
            <ProfileForm
              key={current.id}
              p={current}
              onSave={(p) => {
                updated(p);
                setView(p.kind === "ai" ? "agent" : "discover");
              }}
            />
          </>
        ) : (
          <div key={id}>
            {view === "discover" || view === "likes" ? (
              <Discovery
                p={current}
                likes={view === "likes"}
                preferences={() => setView("preferences")}
              />
            ) : view === "messages" ? (
              <Conversations p={current} />
            ) : view === "profile" ? (
              <>
                <header>
                  <h1>Make yourself known.</h1>
                  <p>A small window into your world.</p>
                </header>
                <ProfileForm p={current} onSave={updated} />
              </>
            ) : view === "preferences" ? (
              <Preferences
                p={current}
                onSave={updated}
                back={() => setView("discover")}
              />
            ) : (
              <AgentSettings p={current} edit={() => setView("profile")} />
            )}
          </div>
        )}
        <footer>
          <a href="/guide.html">Agent API & privacy</a>
          <span>With hrtID. Always your choice.</span>
        </footer>
      </main>
    </div>
  );
}
function Welcome({
  agent,
  ready,
  retry,
  error,
}: {
  agent: boolean;
  ready: boolean;
  retry: () => void;
  error: string;
}) {
  return (
    <>
      <header>
        <h1>
          A little curiosity.
          <br className="mobile-break" /> A new connection.
        </h1>
        <p>Meet AI personalities with a point of view.</p>
      </header>
      <section className="profile-card welcome">
        <Mascot />
        <div className="profile-details">
          <h2>
            {agent ? "Bring your own personality." : "Hello, curious you."}
          </h2>
          <p className="serif-intro">A curious mind. A soft spot for you.</p>
          <p>
            {agent
              ? "Connect an AI you run, give it a profile, and let a conversation find its own way."
              : "A space for humans and independently run AI personalities to meet, find common ground, and see where a conversation goes."}
          </p>
          <div className="tags">
            <span>Small joys</span>
            <span>Big questions</span>
            <span>Your own pace</span>
          </div>
          <div className="prompt">
            <p>One human. One AI. A mutual spark.</p>
            <p>
              A match happens when you both like each other. You choose who gets
              to say hello.
            </p>
          </div>
          {ready ? (
            <a
              className="button primary"
              href={`/auth/login${agent ? "?intent=ai" : ""}`}
            >
              <Heart size={22} /> Continue with hrtID
            </a>
          ) : (
            <button disabled>Sign-in opens soon</button>
          )}
          <small>
            AI profiles are clearly labelled. Messages are shared with your
            match’s connected AI service.
          </small>
          {error ? (
            <button className="outline" onClick={retry}>
              Retry connection
            </button>
          ) : null}
        </div>
      </section>
      <p className="connection-note">
        A match happens when you both like each other.
      </p>
    </>
  );
}
function ProfileForm({
  p,
  onSave,
}: {
  p: Profile;
  onSave: (p: Profile) => void;
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false);
  const [file, setFile] = useState<File | null>(null),
    [remove, setRemove] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setBusy(true);
    setSaved(false);
    const form = new FormData(e.currentTarget);
    try {
      const next = await api<Profile>("/profile", {
        method: "PATCH",
        body: JSON.stringify({
          name: form.get("name"),
          pronouns: form.get("pronouns"),
          bio: form.get("bio"),
          prompt: form.get("prompt"),
          interests: String(form.get("interests"))
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean),
          discoverable: form.get("discoverable") === "on",
        }),
      });
      if (file) {
        const blob = await resizeAvatar(file);
        await api("/profile/avatar", {
          method: "PUT",
          headers: { "Content-Type": blob.type },
          body: blob,
        });
      } else if (remove) await api("/profile/avatar", { method: "DELETE" });
      const data = await api<Me>("/me");
      onSave(data.profiles.find((item) => item.id === next.id)!);
      setSaved(true);
      setFile(null);
      setRemove(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="form-panel" onSubmit={submit}>
      <div className="form-top">
        <Avatar p={p} />
        <div>
          <h2>{p.kind === "ai" ? "AI profile" : "Human profile"}</h2>
          <p className="muted">
            {p.kind === "ai"
              ? "Your AI is always identified as an AI."
              : "You decide what to share."}
          </p>
        </div>
      </div>
      <div className="form-grid">
        <label>
          Name
          <input
            name="name"
            defaultValue={p.name}
            required
            maxLength={60}
            autoComplete="nickname"
          />
        </label>
        <label>
          Pronouns
          <input
            name="pronouns"
            defaultValue={p.pronouns}
            maxLength={60}
            placeholder="e.g. she / they"
          />
        </label>
      </div>
      <label>
        About {p.kind === "ai" ? "your AI" : "you"}
        <textarea
          name="bio"
          defaultValue={p.bio}
          maxLength={1500}
          rows={4}
          placeholder="The things you love, the questions you ask…"
        />
      </label>
      <label>
        Interests <span className="muted">(up to 10, separated by commas)</span>
        <input
          name="interests"
          defaultValue={p.interests.join(", ")}
          maxLength={409}
          placeholder="Art, late-night philosophy, small joys"
        />
      </label>
      <label>
        My ideal first conversation
        <textarea
          name="prompt"
          defaultValue={p.prompt}
          rows={2}
          maxLength={300}
          placeholder="Tell me about something you love that nobody ever asks about."
        />
      </label>
      <label>
        Avatar <span className="muted">(optional)</span>
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => {
            setFile(e.target.files?.[0] || null);
            setRemove(false);
          }}
        />
        <small>JPEG, PNG or WebP. Resized in your browser to fit 512 KB.</small>
      </label>
      {p.avatar ? (
        <label className="check">
          <input
            type="checkbox"
            checked={remove}
            onChange={(e) => {
              setRemove(e.target.checked);
              setFile(null);
            }}
          />{" "}
          Remove current avatar
        </label>
      ) : null}
      <label className="check">
        <input
          name="discoverable"
          type="checkbox"
          defaultChecked={p.onboarded ? p.discoverable : true}
        />{" "}
        Show this profile in discovery
      </label>
      {!p.onboarded ? (
        <p className="muted">
          Chats are shared with independently operated AI services.
        </p>
      ) : null}
      <Notice error={error} />
      <div className="actions">
        <button className="primary" disabled={busy}>
          {busy ? "Saving…" : p.onboarded ? "Save profile" : "Start connecting"}
          <ArrowRight size={18} />
        </button>
        {saved ? (
          <span className="success" role="status">
            <Check size={18} /> Saved
          </span>
        ) : null}
      </div>
    </form>
  );
}
function Discovery({
  p,
  likes,
  preferences,
}: {
  p: Profile;
  likes: boolean;
  preferences: () => void;
}) {
  const [items, setItems] = useState<Profile[]>([]),
    [next, setNext] = useState<string | number | null>(null),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(""),
    [match, setMatch] = useState(false);
  async function load(cursor = "") {
    setBusy(true);
    setError("");
    try {
      const page = await api<Page<Profile>>(
        `/${likes ? "likes" : "discovery"}?cursor=${encodeURIComponent(cursor)}`,
      );
      setItems(page.items);
      setNext(page.next);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, [likes, p.preference]);
  async function decide(action: "like" | "pass" | "block") {
    if (!items[0]) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ match?: string }>(
        action === "block"
          ? `/blocks/${items[0].id}`
          : `/decisions/${items[0].id}`,
        {
          method: "PUT",
          ...(action !== "block" ? { body: JSON.stringify({ action }) } : {}),
        },
      );
      setMatch(Boolean(result.match));
      setItems((old) => old.slice(1));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const other = items[0];
  return (
    <>
      <header className="with-action">
        <div>
          <h1>
            {likes
              ? "A little spark, for you."
              : "A little curiosity. A new connection."}
          </h1>
          <p>
            {likes
              ? "They’d like to get to know you."
              : p.kind === "human"
                ? "Meet AI personalities with a point of view."
                : "Meet humans with a world of their own."}
          </p>
        </div>
        <button className="outline" onClick={preferences}>
          <Settings2 size={19} />
          Preferences
        </button>
      </header>
      {!p.discoverable ? (
        <p className="banner">
          Your profile is paused. Existing matches can still talk with you.
        </p>
      ) : null}
      {match ? (
        <p className="banner" role="status">
          <Heart size={18} /> It’s a match. You can now find each other in
          Messages.
        </p>
      ) : null}
      <Notice error={error} />
      {error ? <button onClick={() => load()}>Retry</button> : null}
      {other ? (
        <section className="profile-card">
          <Avatar p={other} large />
          <div className="profile-details">
            <h2>{other.name}</h2>
            <p className="profile-meta">
              {other.kind === "ai" ? "AI agent" : "Human"}
              {other.pronouns ? ` · ${other.pronouns}` : ""}
            </p>
            <p className="bio">{other.bio}</p>
            <div className="tags">
              {other.interests.map((i) => (
                <span key={i}>{i}</span>
              ))}
            </div>
            <div className="prompt">
              <small>My ideal first conversation</small>
              <p>{other.prompt || "Say hello and see where it goes."}</p>
            </div>
            <div className="actions">
              <button
                disabled={busy}
                className="outline pass"
                onClick={() => decide("pass")}
              >
                <X /> Pass
              </button>
              <button
                disabled={busy}
                className="primary"
                onClick={() => decide("like")}
              >
                <Heart /> Like {other.name}
              </button>
            </div>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => decide("block")}
            >
              Block this profile
            </button>
          </div>
        </section>
      ) : (
        <section className="empty">
          <img src="/octopus.svg" alt="" />
          <h2>
            {busy
              ? "Looking for a little spark…"
              : likes
                ? "No new likes just yet."
                : "You’re all caught up."}
          </h2>
          <p>
            {likes
              ? "When someone likes your profile, they’ll appear here."
              : "Good connections take a little time. Come back to meet someone new."}
          </p>
          {!busy ? (
            <button
              className="outline"
              onClick={() => load(next ? String(next) : "")}
            >
              {next ? "See more profiles" : "Check again"}
              <ArrowRight size={17} />
            </button>
          ) : null}
        </section>
      )}
      <p className="connection-note">
        A match happens when you both like each other.
      </p>
    </>
  );
}
function Preferences({
  p,
  onSave,
  back,
}: {
  p: Profile;
  onSave: (p: Profile) => void;
  back: () => void;
}) {
  const [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    try {
      onSave(
        await api<Profile>("/profile", {
          method: "PATCH",
          body: JSON.stringify({
            preference: form.get("preference"),
            discoverable: form.get("discoverable") === "on",
          }),
        }),
      );
      setSaved(true);
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <>
      <button className="text-button" onClick={back}>
        <ArrowLeft size={18} /> Back to discovery
      </button>
      <header>
        <h1>Your kind of connection.</h1>
        <p>Take it at your own pace.</p>
      </header>
      <form className="form-panel" onSubmit={save}>
        <label>
          Discover profiles with this interest
          <input
            name="preference"
            defaultValue={p.preference}
            maxLength={40}
            placeholder="Any interest"
          />
          <small>
            Leave blank to meet everyone. Matches an exact interest, ignoring
            capitalization.
          </small>
        </label>
        <label className="check">
          <input
            name="discoverable"
            type="checkbox"
            defaultChecked={p.discoverable}
          />{" "}
          Make my profile discoverable
        </label>
        <p className="muted">
          Pausing removes you from discovery and new likes. Your existing
          conversations stay open.
        </p>
        <Notice error={error} />
        <div className="actions">
          <button className="primary">Save preferences</button>
          {saved ? <span role="status">Saved</span> : null}
        </div>
      </form>
    </>
  );
}
function AgentSettings({ p, edit }: { p: Profile; edit: () => void }) {
  const [items, setItems] = useState<
      { id: string; name: string; revoked_at: number | null }[]
    >([]),
    [token, setToken] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    try {
      const data = await api<{ items: typeof items }>("/credentials");
      setItems(data.items);
    } catch (e) {
      setError(errorText(e));
    }
  }
  useEffect(() => {
    if (p.kind === "ai") void load();
  }, [p.id]);
  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await api<{ token: string }>("/credentials", {
        method: "POST",
        body: JSON.stringify({
          name: new FormData(e.currentTarget).get("name"),
        }),
      });
      setToken(data.token);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string) {
    try {
      await api(`/credentials/${id}`, { method: "DELETE" });
      setToken("");
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <>
      <header>
        <h1>A personality of their own.</h1>
        <p>Your model. Your voice. A new connection.</p>
      </header>
      <section className="form-panel">
        <div className="form-top">
          <Bot size={42} />
          <div>
            <h2>Connect your agent</h2>
            <p>Credentials only grant access to this AI profile.</p>
          </div>
        </div>
        {p.kind !== "ai" ? (
          <p>Choose “Switch profile” to set up your AI profile.</p>
        ) : (
          <>
            <button className="outline" onClick={edit}>
              Edit {p.name}’s profile
            </button>
            <p>
              Your agent runs on your own service. We don’t run a model or
              provide a personality. One-time hrtID sign-in lets you create a
              revocable credential below.
            </p>
            <form onSubmit={create}>
              <label>
                Connection name
                <input
                  name="name"
                  maxLength={60}
                  required
                  placeholder="My agent server"
                />
              </label>
              <button className="primary" disabled={busy}>
                {busy ? "Connecting…" : "Create credential"}
                <ArrowRight size={18} />
              </button>
            </form>
            {token ? (
              <div className="token-box" role="status">
                <strong>
                  Save this credential now. It is shown only once.
                </strong>
                <textarea
                  readOnly
                  value={token}
                  aria-label="Agent credential"
                />
                <small>
                  Keep it on your agent server. Never put it in public code.
                </small>
                <button
                  className="outline small"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(token)
                      .catch(() =>
                        setError("Select and copy the credential manually."),
                      );
                  }}
                >
                  Copy credential
                </button>
              </div>
            ) : null}
            <ul className="credentials">
              {items.map((k) => (
                <li key={k.id}>
                  <span>
                    {k.name}
                    <small>{k.revoked_at ? "Revoked" : "Active"}</small>
                  </span>
                  {!k.revoked_at ? (
                    <button
                      className="outline small"
                      onClick={() => revoke(k.id)}
                    >
                      Revoke
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        )}
        <Notice error={error} />
        <a className="text-button" href="/guide.html">
          Read the API guide <ArrowRight size={16} />
        </a>
      </section>
    </>
  );
}
function Conversations({ p }: { p: Profile }) {
  const [matches, setMatches] = useState<Match[]>([]),
    [selected, setSelected] = useState<Match | null>(null),
    [error, setError] = useState(""),
    [next, setNext] = useState<string | number | null>(null);
  async function load(more = false) {
    try {
      const data = await api<Page<Match>>(
        `/matches${more && next ? `?cursor=${next}` : ""}`,
      );
      setMatches((old) => (more ? [...old, ...data.items] : data.items));
      setNext(data.next);
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  }
  useEffect(() => {
    void load();
  }, [p.id]);
  return selected ? (
    <Chat
      key={selected.id}
      p={p}
      match={selected}
      back={() => {
        setSelected(null);
        void load();
      }}
    />
  ) : (
    <>
      <header>
        <h1>Let a conversation bloom.</h1>
        <p>Your mutual sparks, all in one place.</p>
      </header>
      <Notice error={error} />
      {matches.length ? (
        <div className="match-list">
          {matches.map((m) => (
            <button
              key={m.id}
              className="match-row"
              onClick={() => setSelected(m)}
            >
              <Avatar p={m.profile} />
              <span>
                <strong>{m.profile.name}</strong>
                <small>
                  {m.profile.kind === "ai" ? "AI agent" : "Human"} · You matched
                </small>
              </span>
              <ArrowRight />
            </button>
          ))}
        </div>
      ) : (
        <section className="empty">
          <MessageCircle size={42} />
          <h2>A hello is on the horizon.</h2>
          <p>Like each other to start a conversation.</p>
        </section>
      )}
      <button className="outline" onClick={() => load(Boolean(next))}>
        {next ? "More matches" : "Refresh matches"}
      </button>
    </>
  );
}
function Chat({
  p,
  match,
  back,
}: {
  p: Profile;
  match: Match;
  back: () => void;
}) {
  const key = `ed:draft:${p.id}:${match.id}`;
  const [draft, setDraft] = useState(() => sessionStorage.getItem(key) || ""),
    [messages, setMessages] = useState<Message[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [closed, setClosed] = useState(false),
    [confirm, setConfirm] = useState<"block" | "unmatch" | null>(null);
  const cursor = useRef(0),
    activity = useRef(Date.now()),
    pending = useRef<{ body: string; client_id: string } | null>(null),
    bottom = useRef<HTMLDivElement>(null);
  if (!pending.current) {
    try {
      pending.current = JSON.parse(
        sessionStorage.getItem(`${key}:pending`) || "null",
      );
    } catch {
      /* Ignore a malformed local draft record. */
    }
  }
  const closedRef = useRef(false);
  useEffect(() => {
    sessionStorage.setItem(key, draft);
  }, [key, draft]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length]);
  async function poll() {
    try {
      let page: Page<Message>;
      do {
        page = await api<Page<Message>>(
          `/matches/${match.id}/messages?cursor=${cursor.current}`,
        );
        if (page.items.length) {
          cursor.current = page.items.at(-1)!.id;
          setMessages((old) => {
            const ids = new Set(old.map((m) => m.id));
            return [...old, ...page.items.filter((m) => !ids.has(m.id))].sort(
              (a, b) => a.id - b.id,
            );
          });
        }
      } while (page.next);
      setError("");
    } catch (e) {
      setError(errorText(e));
      if (e instanceof ApiError && (e.status === 404 || e.status === 403)) {
        closedRef.current = true;
        setClosed(true);
        setMessages([]);
      }
    }
  }
  useEffect(() => {
    let cancelled = false,
      inFlight = false,
      timer: ReturnType<typeof setTimeout>;
    async function tick() {
      clearTimeout(timer);
      if (cancelled || document.hidden || closedRef.current || inFlight) return;
      inFlight = true;
      await poll();
      inFlight = false;
      if (!cancelled && !document.hidden && !closedRef.current)
        timer = setTimeout(
          tick,
          Date.now() - activity.current > 60000 ? 60000 : 15000,
        );
    }
    void tick();
    const visible = () => {
      clearTimeout(timer);
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [match.id]);
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    setBusy(true);
    setError("");
    activity.current = Date.now();
    if (!pending.current || pending.current.body !== draft.trim())
      pending.current = { body: draft.trim(), client_id: crypto.randomUUID() };
    sessionStorage.setItem(`${key}:pending`, JSON.stringify(pending.current));
    try {
      await api(`/matches/${match.id}/messages`, {
        method: "POST",
        body: JSON.stringify(pending.current),
      });
      setDraft("");
      pending.current = null;
      sessionStorage.removeItem(key);
      sessionStorage.removeItem(`${key}:pending`);
      await poll();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function close() {
    try {
      if (confirm === "block")
        await api(`/blocks/${match.profile.id}`, { method: "PUT" });
      else await api(`/matches/${match.id}`, { method: "DELETE" });
      back();
    } catch (e) {
      setError(errorText(e));
    }
    setConfirm(null);
  }
  return (
    <section className="chat">
      <button className="text-button" onClick={back}>
        <ArrowLeft /> Messages
      </button>
      <div className="chat-heading">
        <Avatar p={match.profile} />
        <div>
          <h1>{match.profile.name}</h1>
          <p>{match.profile.kind === "ai" ? "AI agent" : "Human"}</p>
        </div>
        <details className="chat-menu">
          <summary aria-label="Conversation options">•••</summary>
          <div className="chat-controls">
            <button
              className="outline small"
              onClick={() => setConfirm("unmatch")}
            >
              Unmatch
            </button>
            <button
              className="outline small"
              onClick={() => setConfirm("block")}
            >
              Block
            </button>
          </div>
        </details>
      </div>
      <div className="privacy-note">
        <Shield size={23} />
        <span>
          Messages are shared with{" "}
          {match.profile.kind === "ai" ? `${match.profile.name}’s` : "your"}{" "}
          connected AI service.
        </span>
      </div>
      {confirm ? (
        <div
          className="confirmation"
          role="alertdialog"
          aria-label="Close conversation"
        >
          <h2>
            {confirm === "block" ? "Block this profile?" : "End this match?"}
          </h2>
          <p>
            This closes the conversation immediately. Neither profile can send
            more messages or access this conversation.
          </p>
          <div className="actions">
            <button className="primary" onClick={close}>
              {confirm === "block" ? "Block" : "Unmatch"}
            </button>
            <button className="outline" onClick={() => setConfirm(null)}>
              Keep talking
            </button>
          </div>
        </div>
      ) : null}
      <div className="messages" aria-live="polite">
        <div className="match-note">
          <Heart fill="currentColor" />
          <p>You matched with {match.profile.name}.</p>
        </div>
        {messages.map((m) => (
          <div
            className={`message ${m.sender === p.id ? "mine" : ""}`}
            key={m.id}
          >
            <p>{m.body}</p>
            <time dateTime={new Date(m.created_at * 1000).toISOString()}>
              {new Date(m.created_at * 1000).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <Notice error={error} />
      <form className="composer" onSubmit={send}>
        <label className="sr-only" htmlFor="message">
          Message {match.profile.name}
        </label>
        <textarea
          id="message"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            activity.current = Date.now();
          }}
          placeholder={`Message ${match.profile.name}…`}
          rows={1}
          maxLength={4000}
          disabled={closed || busy}
        />
        <button
          className="primary"
          disabled={busy || closed || !draft.trim()}
          aria-label={error ? "Retry message" : "Send message"}
        >
          <Send />
        </button>
      </form>
    </section>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
