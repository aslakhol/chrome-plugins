const FILTERS = {
  tests: {
    label: "Tests",
    match: (path) =>
      /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) ||
      /\.snap$/.test(path) ||
      /(^|\/)(__tests__|__mocks__|tests?|e2e)\//.test(path),
  },
  generated: {
    label: "Generated",
    match: (path) =>
      /(^|\/)generated(\/|\.)/i.test(path) ||
      /(^|\/)i18n-types\.ts$/.test(path) ||
      /(^|\/)superschema\.graphql$/.test(path) ||
      /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/.test(path),
  },
  scratch: {
    label: ".scratch",
    match: (path) => /(^|\/)\.scratch\//.test(path),
  },
  docs: {
    label: "Docs",
    match: (path) => /\.mdx?$/i.test(path) || /(^|\/)docs\//.test(path),
  },
};

const STORAGE_KEY = "grf-modes";
const DIFF_ID = /^diff-[0-9a-f]{64}$/;

// Each button cycles: off → hide matching files → show only matching files → off.
const NEXT_MODE = { off: "hide", hide: "only", only: "off" };
const TITLES = { off: "Hide", hide: "Show only", only: "Show all" };

let modes = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
const modeOf = (key) => modes[key] ?? "off";
const pathByHash = new Map();

const isReviewPage = () => /\/pull\/\d+\/(files|changes)/.test(location.pathname);

const sha256 = async (text) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

// GitHub anchors every file diff as `diff-<sha256(path)>`, in both the classic and the
// new review UI. Find the path by hashing text candidates in the diff until one matches.
const resolvePath = async (el) => {
  const hash = el.id.slice("diff-".length);
  if (pathByHash.has(hash)) return pathByHash.get(hash);

  const candidates = new Set();
  const tagged = el.getAttribute("data-tagsearch-path");
  if (tagged) candidates.add(tagged);
  for (const node of el.querySelectorAll("a, code, h3, span, button")) {
    const text = node.textContent.replace(/[‎‏]/g, "").trim();
    if (text && text.length < 400 && !/\s/.test(text)) candidates.add(text);
    if (candidates.size > 60) break;
  }

  for (const candidate of candidates) {
    if ((await sha256(candidate)) === hash) {
      pathByHash.set(hash, candidate);
      return candidate;
    }
  }
  return undefined;
};

const filtersFor = (path) =>
  Object.entries(FILTERS)
    .filter(([, { match }]) => match(path))
    .map(([key]) => key);

const isHidden = (path) => {
  const matched = filtersFor(path);
  if (matched.some((key) => modeOf(key) === "hide")) return true;
  const only = Object.keys(FILTERS).filter((key) => modeOf(key) === "only");
  return only.length > 0 && !only.some((key) => matched.includes(key));
};

// The item's own text, excluding its nested subtree. Compacted folders read like "graphql/generated".
const treeLabel = (item) =>
  [...item.childNodes]
    .filter((node) => !(node instanceof Element && node.matches("[role='group']")))
    .map((node) => node.textContent)
    .join("")
    .replace(/[‎‏]/g, "")
    .trim();

const treePath = (item) => {
  const labels = [];
  for (let el = item; el; el = el.parentElement?.closest("[role='treeitem']")) labels.unshift(treeLabel(el));
  return labels.join("/");
};

const setHidden = (el, hidden) =>
  hidden ? el.setAttribute("data-grf-hidden", "") : el.removeAttribute("data-grf-hidden");

const apply = async () => {
  const counts = Object.fromEntries(Object.keys(FILTERS).map((key) => [key, 0]));
  const hiddenHashes = new Set();
  const hiddenPaths = new Set();

  const diffs = [...document.querySelectorAll("[id^='diff-']")].filter((el) => DIFF_ID.test(el.id));
  for (const el of diffs) {
    const path = await resolvePath(el);
    if (!path) continue;
    for (const key of filtersFor(path)) counts[key]++;
    const hidden = isHidden(path);
    setHidden(el, hidden);
    if (hidden) {
      hiddenHashes.add(el.id);
      hiddenPaths.add(path);
    }
  }

  // File tree leaves: classic links to `#diff-<hash>`, the new UI uses the path as item id.
  // Skip folders here: they contain their children's links and would be hidden wholesale.
  const knownPaths = new Set(pathByHash.values());
  for (const item of document.querySelectorAll("[role='treeitem']:not([aria-expanded])")) {
    const href = item.querySelector("a[href*='#diff-']")?.getAttribute("href");
    const hash = href?.slice(href.indexOf("#") + 1);
    const path = treePath(item);
    knownPaths.add(path);
    setHidden(item, hiddenHashes.has(hash) || hiddenPaths.has(item.id) || isHidden(path));
  }

  // Collapsed folders don't render their children, so judge folders by every file path we know of.
  for (const item of document.querySelectorAll("[role='treeitem'][aria-expanded]")) {
    const prefix = `${treePath(item)}/`;
    const inside = [...knownPaths].filter((path) => path.startsWith(prefix));
    setHidden(item, inside.length > 0 && inside.every(isHidden));
  }

  renderBar(counts);
};

const renderBar = (counts) => {
  let bar = document.getElementById("grf-bar");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "grf-bar";
    for (const [key, { label }] of Object.entries(FILTERS)) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.key = key;
      button.dataset.label = label;
      button.addEventListener("click", () => {
        modes = { ...modes, [key]: NEXT_MODE[modeOf(key)] };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(modes));
        schedule();
      });
      bar.append(button);
    }
    document.body.append(bar);
  }
  for (const button of bar.querySelectorAll("button")) {
    const key = button.dataset.key;
    const mode = modeOf(key);
    button.textContent = `${mode === "only" ? "Only " : ""}${button.dataset.label} (${counts[key]})`;
    button.title = `${TITLES[mode]} ${button.dataset.label}`;
    button.dataset.mode = mode;
  }
};

let running = false;
let queued = false;

const schedule = async () => {
  if (running) {
    queued = true;
    return;
  }
  running = true;
  if (isReviewPage()) {
    await apply();
  } else {
    document.getElementById("grf-bar")?.remove();
  }
  running = false;
  if (queued) {
    queued = false;
    setTimeout(schedule, 200);
  }
};

let timer;
new MutationObserver((mutations) => {
  // Ignore our own attribute and bar changes to avoid feedback loops.
  const relevant = mutations.some(
    (m) => m.type === "childList" && !(m.target instanceof Element && m.target.closest("#grf-bar")),
  );
  if (!relevant) return;
  clearTimeout(timer);
  timer = setTimeout(schedule, 150);
}).observe(document.body, { childList: true, subtree: true });

schedule();
