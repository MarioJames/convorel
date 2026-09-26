// Adapted from MarioJames/skill-foundry 19f0122 (Apache-2.0); modified for standalone use.
import { RENAME_ICON, RENAME_MASK_PREFIX, RENAME_NAMES } from "./controls.ts";
import { CONTROL_NAME_DOM } from "./dom.ts";
import type { RunControl } from "../semantic.ts";
import { conversationId } from "./page.ts";

export interface OrganizationPreferences {
  projectName?: string;
  projectUrl?: string;
  timezone: string;
  language: "en" | "zh";
}
interface Browser {
  runControl?: RunControl;
  session: string;
  run: (...args: string[]) => Promise<any>;
  read: () => Promise<any>;
}
export interface ConversationMetadata {
  id: string;
  title: string;
  createdAt: string;
  projectId: string | null;
  archived: boolean;
  starred: boolean | null;
  pinnedTime: unknown;
}
export interface OrganizationProgress {
  phase: "locating" | "editing" | "save_pending" | "verifying" | "complete";
  baseline: ConversationMetadata;
  rename: { verified: boolean; title: string };
  project: { state: "skipped" | "pending" | "verified"; id: string | null };
}
const types: Record<string, string> = {
  FEA: "功能",
  DES: "设计",
  FIX: "修复",
  OPT: "优化",
  REL: "发布",
  EXP: "探索",
  DOC: "文档",
  RES: "研究",
};
export function projectId(value: string) {
  const url = new URL(value);
  const match = url.pathname.match(
    /^\/g\/(g-p-[a-z0-9]+)(?:-[^/]+)?\/project$/i,
  );
  if (
    url.origin !== "https://chatgpt.com" ||
    url.username ||
    url.password ||
    !match ||
    url.search ||
    url.hash
  )
    throw new Error("Expected an observed ChatGPT project URL");
  return match[1];
}
export function validatePreferences(value: OrganizationPreferences) {
  if (!!value.projectUrl !== !!value.projectName?.trim())
    throw new Error("Project URL and name must be configured together");
  if (value.projectUrl) projectId(value.projectUrl);
  if (!["en", "zh"].includes(value.language))
    throw new Error("Title language must be en or zh");
  if (!value.timezone) throw new Error("Title timezone is required");
  new Intl.DateTimeFormat("en", { timeZone: value.timezone });
  return value;
}
export function conversationTitle(
  createdAt: string,
  type: string,
  topic: string,
  preferences: OrganizationPreferences,
) {
  if (!Object.hasOwn(types, type))
    throw new Error(
      "Use a title type: FEA, DES, FIX, OPT, REL, EXP, DOC or RES",
    );
  if (!topic?.trim() || /[\r\n｜]/.test(topic) || topic.trim().length > 100)
    throw new Error(
      "Provide a short, single-line topic without a title separator",
    );
  if (!Number.isFinite(Date.parse(createdAt)))
    throw new Error("Actual conversation creation time is required");
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: preferences.timezone,
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(createdAt));
  const date = ["month", "day"]
    .map((type) => parts.find((part) => part.type === type)!.value)
    .join("");
  return `${date}｜${preferences.language === "zh" ? types[type] : type}｜${topic.trim()}`;
}
export function metadataFromResponse(
  data: any,
  id: string,
): ConversationMetadata {
  const body =
    typeof data.responseBody === "string"
      ? JSON.parse(data.responseBody)
      : data.responseBody;
  if (
    data.status !== 200 ||
    body?.conversation_id !== id ||
    typeof body.title !== "string" ||
    typeof body.create_time !== "number" ||
    !Number.isFinite(body.create_time) ||
    body.create_time <= 0 ||
    typeof body.is_archived !== "boolean" ||
    !(body.is_starred === null || typeof body.is_starred === "boolean") ||
    !(body.gizmo_id === null || typeof body.gizmo_id === "string")
  )
    throw new Error(
      "Conversation metadata is missing or does not match the target",
    );
  return {
    id,
    title: body.title,
    createdAt: new Date(body.create_time * 1000).toISOString(),
    projectId: body.gizmo_id,
    archived: body.is_archived,
    starred: body.is_starred,
    pinnedTime: body.pinned_time ?? null,
  };
}

// Only inspect this conversation's visible controls. Selectors are returned, never prompts/account data.
export function organizationUiScript(id: string) {
  return `(() => {
    ${CONTROL_NAME_DOM}
    const visible = e => !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
    const links = Array.from(document.querySelectorAll('a[data-sidebar-item], nav a[data-interactive-row-link]')).filter(e => {
      try { return new URL(e.href).pathname.endsWith('/c/' + ${JSON.stringify(id)}); } catch { return false; }
    });
    let options = 'button[data-conversation-options-trigger=' + JSON.stringify(${JSON.stringify(id)}) + ']';
    let buttons = Array.from(document.querySelectorAll(options)).filter(visible);
    if (!buttons.length) {
      const rows = links.filter(visible).map(e => e.closest('[role="group"]')).filter(Boolean);
      const candidates = [...new Set(rows.flatMap(row => Array.from(row.querySelectorAll('button[aria-haspopup="menu"]')).filter(e => e.closest('[role="group"]') === row && visible(e))))];
      if (candidates.length === 1 && candidates[0].id) {
        options = '#' + CSS.escape(candidates[0].id);
        buttons = candidates;
      }
    }
    if (!buttons.length) {
      // The current conversation header remains available when history is virtualized or collapsed.
      options = 'button[data-testid="conversation-options-button"][id=' + JSON.stringify('conversation-options-' + ${JSON.stringify(id)}) + ']';
      buttons = Array.from(document.querySelectorAll(options)).filter(visible);
    }
    const button = buttons.length === 1 ? buttons[0] : null;
    const panel = links.length === 1 ? links[0].closest('[id]') : null;
    const expanders = panel ? Array.from(document.querySelectorAll('[aria-controls]')).filter(e => visible(e) && e.getAttribute('aria-controls') === panel.id && e.getAttribute('aria-expanded') === 'false') : [];
    let expand = expanders.length === 1 ? '[aria-controls=' + JSON.stringify(panel.id) + ']' : null;
    if (!expand && !button) {
      const selector = 'main header button[aria-controls="browser-sidebar-popover"][aria-expanded="false"]';
      if (Array.from(document.querySelectorAll(selector)).filter(visible).length === 1) expand = selector;
    }
    const menuSelector = button?.id ? '[role="menu"][aria-labelledby=' + JSON.stringify(button.id) + ']' : null;
    const menus = menuSelector ? Array.from(document.querySelectorAll(menuSelector)).filter(visible) : [];
    const renameSelector = menuSelector ? menuSelector + ' [role="menuitem"]:is(:has(svg path[d=' + JSON.stringify(${JSON.stringify(RENAME_ICON)}) + ']), :has([style*=' + JSON.stringify(${JSON.stringify(RENAME_MASK_PREFIX)}) + ']))' : null;
    const actions = menus.length === 1 ? Array.from(document.querySelectorAll(renameSelector)).filter(visible) : [];
    const rename = actions.length === 1 && actions[0].getAttribute('aria-disabled') !== 'true' ? renameSelector : null;
    const namedActions = menus.length === 1 ? Array.from(menus[0].querySelectorAll('[role="menuitem"]')).filter(e => visible(e) && ${JSON.stringify(RENAME_NAMES)}.includes(controlName(e)) && e.getAttribute('aria-disabled') !== 'true') : [];
    const inputSelector = 'input[name="title-editor"], [role="dialog"][aria-modal="true"] form:has(button[type="submit"]) input:not([type])';
    const inputs = Array.from(document.querySelectorAll(inputSelector)).filter(visible);
    return { options: button ? options : null, expand, rename,
      menu: menus.length === 1 ? menuSelector : null,
      renameName: namedActions.length === 1 ? controlName(namedActions[0]) : null,
      titleInput: inputs.length === 1 ? (inputs[0].name === 'title-editor' ? 'input[name="title-editor"]' : '[role="dialog"][aria-modal="true"] form:has(button[type="submit"]) input:not([type])') : null };
  })()`;
}

export async function organizeConversation(
  b: Browser,
  url: string,
  preferences: OrganizationPreferences,
  type: string,
  topic: string,
  onProgress: (progress: OrganizationProgress) => void = () => {},
  metadataBrowser?: Browser,
  recovery: {
    verificationOnly?: boolean;
    baseline?: ConversationMetadata;
  } = {},
) {
  validatePreferences(preferences);
  const id = conversationId(url);
  const configuredProject = preferences.projectUrl
    ? projectId(preferences.projectUrl)
    : undefined;
  // Validate naming inputs before any external mutation, using an arbitrary valid date only for validation.
  conversationTitle("2000-01-01T00:00:00Z", type, topic, preferences);
  const guard = async () => {
    const page = await b.read();
    if (conversationId(page.url) !== id)
      throw new Error("Conversation changed; refusing organization");
    if (
      page.blocked &&
      !(metadataBrowser && page.blocked === "Conversation UI reported an error")
    )
      throw new Error(page.blocked);
    if (page.generating && !metadataBrowser)
      throw new Error(
        "Response is generating; finish monitoring before organizing",
      );
    return page;
  };
  const act = async (...args: string[]) => {
    await guard();
    return b.run(...args);
  };
  const ui = async () => {
    await guard();
    return (await b.run("eval", organizationUiScript(id))).result;
  };
  const waitUi = async (accept: (state: any) => boolean, reason: string) => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const state = await ui();
      if (accept(state)) return state;
      await Bun.sleep(100);
    }
    throw new Error(reason);
  };
  const requests = async (source = b) => {
    // agent-browser returns headers and bodies internally. Never log or persist this response.
    const data = await source.run("network", "requests");
    if (!Array.isArray(data.requests))
      throw new Error("Network observation unavailable");
    return data.requests;
  };
  const waitForSave = async (previous: Set<string>, action: string) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      await guard();
      const writes = (await requests()).filter((r: any) => {
        if (
          previous.has(r.requestId) ||
          !["POST", "PATCH", "PUT"].includes(r.method)
        )
          return false;
        try {
          const u = new URL(r.url);
          return (
            u.origin === "https://chatgpt.com" &&
            u.pathname.startsWith("/backend-api/") &&
            u.pathname.split("/").includes(id)
          );
        } catch {
          return false;
        }
      });
      const rejected = writes.find((r: any) => r.status >= 400);
      if (rejected)
        throw new Error(
          `${action} save rejected (HTTP ${rejected.status}); organization not verified`,
        );
      if (writes.some((r: any) => r.status >= 200 && r.status < 300)) return;
      await Bun.sleep(250);
    }
    throw new Error(
      `${action} save was not acknowledged; leave the page intact and inspect before retrying`,
    );
  };
  const freshMetadata = async (reload = true) => {
    await guard();
    const isMetadata = (r: any) => {
      if (r.method !== "GET") return false;
      try {
        const u = new URL(r.url);
        return (
          u.origin === "https://chatgpt.com" &&
          [
            `/backend-api/conversations/${id}`,
            `/backend-api/conversation/${id}`,
          ].includes(u.pathname)
        );
      } catch {
        return false;
      }
    };
    const source = metadataBrowser ?? b;
    if (conversationId((await source.read()).url) !== id)
      throw new Error("Metadata page changed; refusing organization");
    const observed = await requests(source);
    // A newly attached browser session may not have captured the initial page load.
    reload ||= !observed.some((r: any) => isMetadata(r) && r.status === 200);
    const previous = new Set(
      reload ? observed.map((r: any) => r.requestId) : [],
    );
    if (reload) {
      await guard();
      if (metadataBrowser) await metadataBrowser.run("reload");
      else await act("reload");
    }
    let rejection: number | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      // Metadata can arrive before hydration creates the composer and sidebar.
      await guard();
      const observed = (await requests(source)).filter(
        (r: any) => !previous.has(r.requestId) && isMetadata(r),
      );
      const latest = observed.at(-1);
      // The UI can fall back from the plural endpoint to the singular endpoint.
      // Observe its normal recovery without issuing another request ourselves.
      if (latest?.status >= 400) rejection = latest.status;
      if (latest?.status === 200) {
        await Bun.sleep(250);
        await guard();
        return metadataFromResponse(
          await source.run("network", "request", latest.requestId),
          id,
        );
      }
      await Bun.sleep(250);
    }
    if (rejection)
      throw new Error(
        `Conversation metadata request rejected (HTTP ${rejection}); organization not verified`,
      );
    throw new Error(
      "Fresh conversation metadata unavailable after reload; organization not verified",
    );
  };
  const openOptions = async () => {
    let state = await ui();
    if (!state.options && state.expand) {
      await act("click", state.expand);
      state = await waitUi(
        (s) => !!s.options,
        "Target conversation not visible in sidebar; open its project/history before retrying",
      );
    }
    if (!state.options)
      state = await waitUi(
        (s) => !!s.options,
        "Target conversation not visible in sidebar; open its project/history before retrying",
      );
    // Sidebar hydration can replace Radix ids; anchor the control to this conversation.
    // Keyboard activation also avoids clicking moving sidebar coordinates during expansion.
    await act("focus", state.options);
    await act("press", "Enter");
  };
  const before = await freshMetadata(!!recovery.verificationOnly);
  const baseline = recovery.baseline ?? before;
  if (baseline.id !== id || baseline.projectId !== before.projectId)
    throw new Error("Organization baseline changed; inspect before continuing");
  // An absent destination preserves placement, including an existing user project.
  const expectedProject = configuredProject ?? before.projectId;
  if (before.projectId !== expectedProject)
    throw new Error(
      "Project membership does not match; create the conversation inside the configured project",
    );
  if (before.archived)
    throw new Error(
      "Conversation is archived; refusing to change its archive status",
    );
  const title = conversationTitle(before.createdAt, type, topic, preferences);
  const progress: OrganizationProgress = {
    phase: recovery.verificationOnly ? "verifying" : "locating",
    baseline,
    rename: { verified: false, title },
    project: {
      state: configuredProject ? "pending" : "skipped",
      id: expectedProject,
    },
  };
  onProgress(progress);
  let current = before;
  const checkPreserved = () => {
    if (
      current.createdAt !== baseline.createdAt ||
      current.archived !== baseline.archived ||
      current.starred !== baseline.starred ||
      current.pinnedTime !== baseline.pinnedTime
    )
      throw new Error(
        "Unrelated conversation metadata changed; inspect before continuing",
      );
  };
  checkPreserved();
  if (recovery.verificationOnly && current.title !== title)
    throw new Error(
      "ORGANIZATION_SAVE_UNCONFIRMED: inspect the original title edit; no automatic resubmit",
    );
  if (current.title !== title) {
    await openOptions();
    const menu = await waitUi(
      (s) => !!s.rename || !!s.renameName,
      "Conversation rename action unavailable or ambiguous",
    );
    progress.phase = "editing";
    onProgress(progress);
    if (b.runControl && menu.menu) {
      const page = await guard();
      await b.runControl("click", {
        scope: menu.menu,
        role: "menuitem",
        names: RENAME_NAMES,
        fallback: menu.rename,
        url: page.url,
      });
    } else await act("click", menu.rename);
    const state = await waitUi(
      (s) => !!s.titleInput,
      "Chat title input unavailable",
    );
    if (b.runControl) {
      const page = await guard();
      await b.runControl(
        "fill",
        {
          scope: '[role="dialog"] form, input[name="title-editor"]',
          role: "textbox",
          fallback: state.titleInput,
          url: page.url,
        },
        title,
      );
    } else await act("fill", state.titleInput, title);
    const previous = new Set<string>(
      (await requests()).map((r: any) => r.requestId),
    );
    progress.phase = "save_pending";
    onProgress(progress);
    await act("press", "Enter");
    await waitUi((s) => !s.titleInput, "Chat title edit did not finish");
    await waitForSave(previous, "Title");
    progress.phase = "verifying";
    onProgress(progress);
    current = await freshMetadata();
    if (current.title !== title)
      throw new Error(
        "Renamed title did not persist; organization not verified",
      );
  }
  checkPreserved();
  progress.rename.verified = true;
  onProgress(progress);
  // Without a write, the initial fresh metadata already verifies persistence.
  if (current.title !== title || current.projectId !== expectedProject)
    throw new Error(
      "Title/project did not persist in fresh metadata; organization not verified",
    );
  checkPreserved();
  if (configuredProject) progress.project.state = "verified";
  progress.phase = "complete";
  onProgress(progress);
  return {
    ...progress,
    verified: true,
    changed: before.title !== title || before.projectId !== expectedProject,
    title,
    conversationCreatedAt: current.createdAt,
    projectId: current.projectId,
    projectUrl: preferences.projectUrl,
    projectName: preferences.projectName,
    url: (await b.read()).url,
    session: b.session,
    verifiedAt: new Date().toISOString(),
  };
}
