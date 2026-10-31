import { useEffect, useState } from "preact/hooks";

export type Route = { path: string; query: URLSearchParams };

function parse(): Route {
  const hash = location.hash.replace(/^#/, "") || "/";
  const [path, qs = ""] = hash.split("?");
  return { path: path || "/", query: new URLSearchParams(qs) };
}

export function useRoute(): Route {
  const [route, set] = useState(parse);
  useEffect(() => {
    const on = () => {
      set(parse());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export const go = (to: string) => {
  location.hash = to.startsWith("/") ? to : `/${to}`;
};
