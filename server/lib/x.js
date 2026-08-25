// x.js — grokdev's X account.
// Posting: official X API v2 (twitter-api-v2, OAuth 1.0a user context).
// Reading (mentions/search): twitterapi.io (cheap, no official quota burn) — grokthedev pattern.
// Both degrade to demo mode with no keys.
import { TwitterApi } from "twitter-api-v2";
import { state, save, pushEvent, pruneDaily } from "./state.js";

const TW_READ_KEY = process.env.TWITTERAPI_KEY || "";
const MAX_TWEETS_PER_DAY = Number(process.env.MAX_TWEETS_PER_DAY || 16);

const client = (() => {
  const { X_APP_KEY, X_APP_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } = process.env;
  if (!X_APP_KEY || !X_APP_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_SECRET) return null;
  return new TwitterApi({
    appKey: X_APP_KEY, appSecret: X_APP_SECRET,
    accessToken: X_ACCESS_TOKEN, accessSecret: X_ACCESS_SECRET,
  });
})();

export const isDemo = !client;

export function tweetsLeftToday() {
  pruneDaily();
  return Math.max(0, MAX_TWEETS_PER_DAY - state.tweetsToday.length);
}

export async function postTweet(text, { replyToId } = {}) {
  text = String(text || "").slice(0, 280);
  if (!text) throw new Error("empty tweet");
  if (tweetsLeftToday() <= 0) throw new Error(`daily tweet cap reached (${MAX_TWEETS_PER_DAY})`);
  if (!client) {
    pushEvent("tweet", `[DEMO] would tweet: ${text}`);
    return { id: "demo", demo: true };
  }
  const payload = replyToId ? { text, reply: { in_reply_to_tweet_id: replyToId } } : { text };
  const res = await client.v2.tweet(payload);
  state.tweetsToday.push(Date.now());
  state.lastTweetAt = Date.now();
  save();
  pushEvent("tweet", `tweeted: ${text}`, { tweetId: res.data?.id });
  return { id: res.data?.id };
}

// twitterapi.io advanced search (read) — used for mentions + tracked topics.
export async function searchX(query, { limit = 20 } = {}) {
  if (!TW_READ_KEY) return { demo: true, tweets: [] };
  const url = "https://api.twitterapi.io/twitter/tweet/advanced_search?queryType=Latest&query=" + encodeURIComponent(query);
  const res = await fetch(url, { headers: { "X-API-Key": TW_READ_KEY } });
  if (!res.ok) throw new Error(`twitterapi.io ${res.status}`);
  const data = await res.json();
  return {
    tweets: (data.tweets || []).slice(0, limit).map(t => ({
      id: t.id, user: t.author?.userName, text: t.text, likes: t.likeCount, url: t.url,
    })),
  };
}

export async function readMentions(handle) {
  if (!handle) return { tweets: [] };
  return searchX(`@${handle.replace(/^@/, "")}`, { limit: 20 });
}
