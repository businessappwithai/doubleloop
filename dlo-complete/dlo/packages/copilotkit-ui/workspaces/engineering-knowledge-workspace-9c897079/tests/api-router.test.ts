// @vitest-environment node
//
// Runs in the node environment: this suite constructs real `Request` objects and reads their
// `Response`s, which is what Node's built-in fetch globals are for; nothing here is DOM-dependent.
//
// tests/api-router.test.ts — `src/server/api-router.ts`, the dispatcher `src/ssr.tsx` uses to
// mount `/api/graphql`. The regression it guards is specific and was live: the GraphQL handlers
// were never registered by file-based routing (the pinned framework release ships no
// `createServerFileRoute`), so every GraphQL POST fell through to the router, rendered the SPA
// shell, and came back 404 — the UI loaded but could not reach its own backend. These tests pin
// each branch of the dispatch: mounted path + mounted method delegates, mounted path + unmounted
// method is 405 (never a fall-through, which is what made the original failure invisible),
// unmounted path returns `null` so pages still render, and query strings / lowercase verbs do not
// change the match.
import { describe, expect, test } from "vitest";
import { createApiDispatcher, type ApiHandler } from "../src/server/api-router";

/** Records every request it receives and answers 200 with a marker body. */
function recordingHandler(marker: string): ApiHandler & { calls: Request[] } {
  const calls: Request[] = [];
  const handler = async (request: Request): Promise<Response> => {
    calls.push(request);
    return Response.json({ data: { marker } }, { status: 200 });
  };
  return Object.assign(handler, { calls });
}

describe("createApiDispatcher", () => {
  describe("mounted path and method", () => {
    test("delegates to the handler registered for that path and method", async () => {
      const post = recordingHandler("post");
      const dispatch = createApiDispatcher({ "/api/graphql": { POST: post } });

      const response = await dispatch(
        new Request("http://localhost:3000/api/graphql", { method: "POST", body: "{}" }),
      );

      expect(response).not.toBeNull();
      expect(response?.status).toBe(200);
      await expect(response?.json()).resolves.toEqual({ data: { marker: "post" } });
      expect(post.calls).toHaveLength(1);
    });

    test("passes the original Request through untouched, so handlers can read headers and body", async () => {
      const post = recordingHandler("post");
      const dispatch = createApiDispatcher({ "/api/graphql": { POST: post } });

      await dispatch(
        new Request("http://localhost:3000/api/graphql", {
          method: "POST",
          headers: { "x-actor-id": "abc", "content-type": "application/json" },
          body: JSON.stringify({ query: "{ __typename }" }),
        }),
      );

      const [received] = post.calls;
      expect(received?.headers.get("x-actor-id")).toBe("abc");
      await expect(received?.json()).resolves.toEqual({ query: "{ __typename }" });
    });

    test("routes each method of a path to its own handler", async () => {
      const get = recordingHandler("get");
      const post = recordingHandler("post");
      const dispatch = createApiDispatcher({ "/api/graphql": { GET: get, POST: post } });

      const getResponse = await dispatch(new Request("http://localhost:3000/api/graphql"));
      const postResponse = await dispatch(
        new Request("http://localhost:3000/api/graphql", { method: "POST", body: "{}" }),
      );

      await expect(getResponse?.json()).resolves.toEqual({ data: { marker: "get" } });
      await expect(postResponse?.json()).resolves.toEqual({ data: { marker: "post" } });
      expect(get.calls).toHaveLength(1);
      expect(post.calls).toHaveLength(1);
    });

    test("matches the method case-insensitively", async () => {
      const post = recordingHandler("post");
      const dispatch = createApiDispatcher({ "/api/graphql": { POST: post } });

      // `Request` normalises known verbs, so force the lowercase form through a plain object.
      const response = await dispatch({
        url: "http://localhost:3000/api/graphql",
        method: "post",
      } as Request);

      expect(response?.status).toBe(200);
      expect(post.calls).toHaveLength(1);
    });

    test("ignores the query string and hash when matching the path", async () => {
      const post = recordingHandler("post");
      const dispatch = createApiDispatcher({ "/api/graphql": { POST: post } });

      const response = await dispatch(
        new Request("http://localhost:3000/api/graphql?op=IndexBundlesQuery#frag", {
          method: "POST",
          body: "{}",
        }),
      );

      expect(response?.status).toBe(200);
    });

    test("propagates a handler rejection rather than swallowing it into a fall-through", async () => {
      const boom: ApiHandler = async () => {
        throw new Error("handler exploded");
      };
      const dispatch = createApiDispatcher({ "/api/graphql": { POST: boom } });

      await expect(
        dispatch(new Request("http://localhost:3000/api/graphql", { method: "POST", body: "{}" })),
      ).rejects.toThrow("handler exploded");
    });
  });

  describe("mounted path, unmounted method", () => {
    test("answers 405 instead of falling through to the router", async () => {
      const dispatch = createApiDispatcher({ "/api/graphql": { POST: recordingHandler("post") } });

      const response = await dispatch(
        new Request("http://localhost:3000/api/graphql", { method: "DELETE" }),
      );

      expect(response).not.toBeNull();
      expect(response?.status).toBe(405);
    });

    test("uses the app's standard GraphQL error envelope so relay/fetch.ts needs no special case", async () => {
      const dispatch = createApiDispatcher({ "/api/graphql": { POST: recordingHandler("post") } });

      const response = await dispatch(
        new Request("http://localhost:3000/api/graphql", { method: "PUT" }),
      );

      await expect(response?.json()).resolves.toEqual({
        errors: [
          {
            message: "PUT is not supported by /api/graphql",
            extensions: { code: "method_not_allowed" },
          },
        ],
      });
    });
  });

  describe("unmounted path", () => {
    test("returns null so the request falls through to the router and pages still render", async () => {
      const dispatch = createApiDispatcher({ "/api/graphql": { POST: recordingHandler("post") } });

      await expect(dispatch(new Request("http://localhost:3000/"))).resolves.toBeNull();
      await expect(dispatch(new Request("http://localhost:3000/bundles/abc"))).resolves.toBeNull();
    });

    test("does not treat a path that merely prefixes a mounted route as a match", async () => {
      const dispatch = createApiDispatcher({ "/api/graphql": { POST: recordingHandler("post") } });

      await expect(
        dispatch(
          new Request("http://localhost:3000/api/graphql/extra", { method: "POST", body: "{}" }),
        ),
      ).resolves.toBeNull();
      await expect(
        dispatch(new Request("http://localhost:3000/api", { method: "POST", body: "{}" })),
      ).resolves.toBeNull();
    });

    test("does not resolve inherited Object properties as routes", async () => {
      // A bare `Record` lookup would find `Object.prototype.constructor` and answer 405 for it.
      const dispatch = createApiDispatcher({ "/api/graphql": { POST: recordingHandler("post") } });

      await expect(dispatch(new Request("http://localhost:3000/constructor"))).resolves.toBeNull();
      await expect(dispatch(new Request("http://localhost:3000/toString"))).resolves.toBeNull();
    });
  });

  describe("empty route table", () => {
    test("returns null for every request", async () => {
      const dispatch = createApiDispatcher({});

      await expect(dispatch(new Request("http://localhost:3000/api/graphql"))).resolves.toBeNull();
      await expect(dispatch(new Request("http://localhost:3000/"))).resolves.toBeNull();
    });
  });

  describe("path mounted with no methods", () => {
    test("answers 405 for every method rather than falling through", async () => {
      const dispatch = createApiDispatcher({ "/api/graphql": {} });

      const response = await dispatch(new Request("http://localhost:3000/api/graphql"));

      expect(response?.status).toBe(405);
    });
  });
});
