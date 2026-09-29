import type { IncomingMessage } from "node:http";

export function cookies(request: IncomingMessage): Map<string, string> {
  return new Map(
    (request.headers.cookie ?? "").split(";").map((part) => {
      const index = part.indexOf("=");
      return index > 0
        ? [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())]
        : ["", ""];
    }),
  );
}
