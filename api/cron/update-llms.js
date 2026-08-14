// api/cron/update-llms.js
//
// Runs on a schedule (see vercel.json "crons"). Checks the stewards.loan
// blog RSS feed for the 4 newest posts. If they differ from what's
// currently listed in llms.txt's "Featured Posts" section, rewrites
// that section and bumps "Last Updated", then commits the change to
// GitHub (which triggers the existing auto-deploy to ai.stewards.loan).
//
// Safety principle: if ANY step fails or returns unexpected data,
// this function does nothing rather than writing partial/bad content.
// The last known-good llms.txt is always preferred over a "fixed forward"
// broken one.

const RSS_URL = "https://www.stewards.loan/blog/rss";
const GITHUB_OWNER = "the-stewards";
const GITHUB_REPO = "agent";
const GITHUB_FILE_PATH = "public/llms.txt";
const GITHUB_BRANCH = "main";

export default async function handler(req, res) {
  // --- Auth: only allow Vercel Cron (or someone with the secret) to trigger this ---
  const authHeader = req.headers["authorization"];
  if (
    !process.env.CRON_SECRET ||
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  try {
    const feedItems = await fetchTopFeedItems(4);
    if (!feedItems || feedItems.length < 4) {
      return res
        .status(200)
        .json({ ok: false, skipped: true, reason: "feed_incomplete" });
    }

    const { content: currentContent, sha } = await fetchCurrentLlmsTxt();
    if (!currentContent || !sha) {
      return res
        .status(200)
        .json({ ok: false, skipped: true, reason: "github_fetch_failed" });
    }

    const currentUrls = extractCurrentFeaturedUrls(currentContent);
    const newUrls = feedItems.map((item) => item.link);

    const unchanged =
      currentUrls.length === newUrls.length &&
      currentUrls.every((url, i) => url === newUrls[i]);

    if (unchanged) {
      return res.status(200).json({ ok: true, updated: false, reason: "no_change" });
    }

    const updatedContent = buildUpdatedLlmsTxt(currentContent, feedItems);
    if (!updatedContent) {
      return res
        .status(200)
        .json({ ok: false, skipped: true, reason: "content_build_failed" });
    }

    await commitToGitHub(updatedContent, sha);

    return res.status(200).json({
      ok: true,
      updated: true,
      newFeaturedUrls: newUrls,
    });
  } catch (err) {
    // Never let an unexpected error write anything. Just report it.
    return res.status(200).json({ ok: false, error: String(err) });
  }
}

// ---------- RSS ----------

async function fetchTopFeedItems(count) {
  const response = await fetch(RSS_URL);
  if (!response.ok) return null;

  const xml = await response.text();

  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g);
  if (!itemBlocks || itemBlocks.length === 0) return null;

  const items = itemBlocks.slice(0, count).map((block) => {
    const title = extractTag(block, "title");
    const description = extractTag(block, "description");
    const link = extractTag(block, "link");

    return {
      title: cleanText(title),
      description: cleanDescription(cleanText(description)),
      link: cleanText(link),
    };
  });

  // Bail if any item is missing a required field — better to skip
  // the whole update than write a broken entry.
  const allValid = items.every((i) => i.title && i.link);
  return allValid ? items : null;
}

function extractTag(block, tagName) {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = block.match(regex);
  return match ? match[1] : "";
}

function cleanText(raw) {
  if (!raw) return "";
  // Strip CDATA wrapper if present
  const cdataMatch = raw.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  const text = cdataMatch ? cdataMatch[1] : raw;
  return text.trim();
}

function cleanDescription(desc) {
  if (!desc) return "";
  // Remove trailing truncation artifact and any stray whitespace runs
  return desc
    .replace(/\.\.\.$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------- GitHub ----------

async function fetchCurrentLlmsTxt() {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}?ref=${GITHUB_BRANCH}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `token ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!response.ok) return { content: null, sha: null };

  const data = await response.json();
  if (!data.content || !data.sha) return { content: null, sha: null };

  const decoded = Buffer.from(data.content, "base64").toString("utf-8");
  return { content: decoded, sha: data.sha };
}

async function commitToGitHub(newContent, sha) {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE_PATH}`;
  const body = {
    message: "Auto-update llms.txt: refresh Featured Posts and Last Updated date",
    content: Buffer.from(newContent, "utf-8").toString("base64"),
    sha,
    branch: GITHUB_BRANCH,
  };

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `token ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`GitHub commit failed: ${response.status} ${errText}`);
  }
}

// ---------- llms.txt content building ----------

function extractCurrentFeaturedUrls(content) {
  const section = content.match(
    /### Featured Posts([\s\S]*?)### Full Archive/
  );
  if (!section) return [];

  const urls = section[1].match(/https:\/\/www\.stewards\.loan\/blog\/\S+/g);
  return urls ? urls.map((u) => u.replace(/\s+$/, "")) : [];
}

function buildUpdatedLlmsTxt(currentContent, feedItems) {
  const today = new Date().toISOString().slice(0, 10);

  let updated = currentContent.replace(
    /# Last Updated: .*/,
    `# Last Updated: ${today}`
  );

  const newFeaturedBlock = feedItems
    .map((item) => {
      const wrappedDescription = wrapText(item.description, 70, "    ");
      return `${item.link}\n    — ${wrappedDescription}`;
    })
    .join("\n\n");

  const sectionRegex = /(### Featured Posts\s*\n)([\s\S]*?)(\n+### Full Archive)/;
  if (!sectionRegex.test(updated)) return null;

  updated = updated.replace(
    sectionRegex,
    `$1${newFeaturedBlock}$3`
  );

  return updated;
}

function wrapText(text, width, indent) {
  const words = text.split(" ");
  const lines = [];
  let currentLine = "";

  for (const word of words) {
    if ((currentLine + " " + word).trim().length > width) {
      lines.push(currentLine.trim());
      currentLine = word;
    } else {
      currentLine += " " + word;
    }
  }
  if (currentLine.trim()) lines.push(currentLine.trim());

  return lines.join("\n" + indent + "  ");
}
