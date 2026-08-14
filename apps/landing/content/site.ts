/**
 * Every word on the page.
 *
 * Sections read from here rather than holding their own strings, so changing a
 * headline is one edit in one file and a section stays a layout. The shapes are
 * the design's shapes -- a features grid is two cards and a wide one, not an
 * array of N -- so a copy change cannot quietly restructure a section.
 */

export const NAV_LINKS = [
  { label: "Product", href: "#product" },
  { label: "Docs", href: "#docs" },
  { label: "Roadmap", href: "#roadmap" },
  { label: "Changelog", href: "#changelog" },
] as const

export const GITHUB_URL = "https://github.com/evie-sh/evie"

/** Placeholder until the repo is public and this reads from the GitHub API. */
export const GITHUB_STARS = "4.2k"

export const HERO = {
  badge: "OPEN SOURCE",
  note: "v0.4 brings remote environments",
  title: { before: "Meet", after: "Evie" },
  lede: "A minimal, open-source GUI for eve agents. Bring your own key, run it on your own machine, and let your bots keep working after you close the laptop.",
} as const

export const CTA = {
  download: "Download for macOS",
  /** The masthead has room for the verb only. */
  navDownload: "Download",
  command: "npx evie",
} as const

export const STATEMENT = {
  heading: "Message bots like teammates.",
  paragraphs: [
    "Hand work to a bot the way you would hand it to a person: in a sentence, in a thread, from whatever device is in front of you.",
    "They keep the context of every turn, work while the window is closed, and come back when there is something that actually needs you.",
  ],
} as const

export const FEATURES = {
  heading: "Work with many bots at once",
  lede: "Name a bot, give it a job, and let it run. One bot drafts while another watches your inbox and a third sits on a repo you have not opened in a week.",
  cards: [
    {
      title: "A bot starts as a name",
      body: "Pick a face, type what it is called, and start talking. No graph to wire, no config file to learn first.",
    },
    {
      title: "Plug in the tools it needs",
      body: "Gmail, Calendar, Slack, Linear, GitHub. Add a plugin once and every bot you run can reach it — with your keys, on your machine.",
    },
  ],
  wide: {
    eyebrow: "IN THE THREAD",
    title: "It asks before it acts",
    body: "When a bot needs a key, a scope, or a decision, it stops and asks in the thread — with the options spelled out. Nothing reaches your accounts because a plan looked good.",
  },
} as const

export const REMOTE = {
  chip: "THIS MAC · LIVE",
  heading: "The server is your computer",
  lede: "Evie runs as one environment you own: your files, your keys, your provider CLIs. Reach it from the desktop app, from a browser on the same network, or from anywhere over Tailscale.",
  modes: [
    {
      label: "01 — DESKTOP",
      title: "Install and go",
      body: "The Mac app bundles the server. Nothing to host, nothing to sign up for, no data leaving the machine.",
    },
    {
      label: "02 — BROWSER",
      title: "npx evie, then any tab",
      body: "One command serves the same app on your network. Phone on the sofa, laptop at the desk, same threads.",
    },
    {
      label: "03 — REMOTE",
      title: "Tailscale or a tunnel",
      body: "Connect from tryevie.ai to the machine at home and keep driving the bots you left running there.",
    },
  ],
} as const

export const JOBS = {
  heading: "Give each bot a job",
  body: "Start from a suggestion or write the job yourself. The bot keeps that job across every thread, so you stop re-explaining what you want and start reading what it did.",
  chips: [
    "Inbox Triage",
    "Channel Digest",
    "Recruiting",
    "Deck Designer",
    "Night Shift",
    "Standup Notes",
  ],
} as const

export const PRICING = {
  eyebrow: "PRICING",
  heading: "Free, and yours",
  lede: "There is no plan to choose. Evie is MIT licensed and runs on your hardware — you only ever pay the model provider you already use.",
  plans: [
    {
      label: "Evie",
      price: "$0",
      unit: "forever",
      blurb: "The whole app, on your machine.",
      action: { label: CTA.download, variant: "primary" },
      listLabel: "INCLUDES",
      items: [
        "As many bots and threads as you want",
        "Every plugin in the marketplace",
        "Desktop app, local web app, remote access",
        "Checkpoints and restore on every turn",
        "The full source, and a fork if you want one",
      ],
    },
    {
      label: "Your provider",
      price: "Your key",
      blurb: "Billed by them, never seen by us.",
      action: { label: "Read the setup guide", variant: "secondary" },
      listLabel: "WORKS WITH",
      items: [
        "Any provider your eve agents already use",
        "The CLIs and subscriptions on your machine",
        "Keys held locally, never proxied through us",
        "No account required to run it locally",
        "Swap models per bot, not per app",
      ],
    },
  ],
} as const

export const FAQ = {
  heading: "Questions",
  lede: "Everything else is in the docs, and the parts we have not built yet are on the public roadmap.",
  items: [
    {
      question: "What exactly is an eve agent?",
      answer:
        "eve is the framework the bots run on: instructions, tools, skills, and durable sessions that survive restarts. Evie is the window onto it — it starts the runtime, keeps the transcript, and gives every agent a face and a name.",
    },
    {
      question: "Do I need my own API key?",
      answer:
        "Yes, and that is the deal. Evie uses whatever provider your agents are already set up for, with credentials that stay on your machine. There is no Evie account in the middle, no proxy, and no margin on your tokens.",
    },
    {
      question: "Does anything I type leave my machine?",
      answer:
        "Only what a bot sends to the model provider you picked, and to the services you connected it to. Threads, checkpoints, and keys live in your Evie home directory — there is no server of ours for them to reach.",
    },
    {
      question: "Is there a Windows or Linux build?",
      answer:
        "The desktop app is macOS today. Everywhere else, `npx evie` serves the same app from any machine with Node and you open it in a browser. That is not the consolation path: it is the same one remote access uses.",
    },
    {
      question: "How do I reach my bots from my phone?",
      answer:
        "Open the web app over your network, or put the machine on Tailscale and sign in from tryevie.ai. Either way the phone is a window onto the environment at home, not a second copy of it, so the thread you left open is the thread you land in.",
    },
    {
      question: "Can I fork it and ship my own?",
      answer:
        "Yes. Evie is MIT licensed and a good number of people already run forks. The roadmap and the design notes are public too, so you can see where it is going before you decide to branch.",
    },
  ],
} as const

export const CLOSING = {
  heading: "Meet your first bot",
  tagline: "Your team of always-on bots that you can give real work to.",
} as const

export const FOOTER = {
  blurb: "A minimal GUI for eve agents. Built in the open at tryevie.ai.",
  columns: [
    {
      label: "PRODUCT",
      links: ["Download", "Plugins", "Remote access", "Changelog"],
    },
    {
      label: "DOCS",
      links: ["Getting started", "Providers and keys", "Writing a plugin", "Self-hosting"],
    },
    {
      label: "OPEN",
      links: ["GitHub", "Roadmap", "Discussions", "Contributing"],
    },
    {
      label: "LEGAL",
      links: ["MIT license", "Privacy", "Security", "Trademarks"],
    },
  ],
  colophon: "MIT licensed · v0.4.2",
} as const
