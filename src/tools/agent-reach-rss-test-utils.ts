import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface RssTestRoute {
  status: number;
  location?: string;
  body?: string;
  headers?: Record<string, string>;
}

/**
 * Install deterministic Python modules for RSS redirect tests. The fake
 * urllib opener never opens a socket; the production sitecustomize policy
 * still validates every URL through socket.getaddrinfo before the opener sees
 * it. This keeps the tests independent of external DNS and HTTP services.
 */
export async function installRssPythonFixtures(
  testDir: string,
  routes: Record<string, RssTestRoute>,
): Promise<void> {
  const urllibDir = join(testDir, "urllib");
  await mkdir(urllibDir);
  await writeFile(
    join(testDir, "feedparser.py"),
    `class _Entry:
    title = "validated RSS"
    link = "https://articles.example/validated"
    summary = "validated body"

class _Parsed:
    entries = [_Entry()]

def parse(source):
    if not isinstance(source, (bytes, bytearray)):
        raise RuntimeError("feedparser received a URL instead of response bytes")
    marker = __import__("os").environ.get("AGENT_REACH_RSS_PARSE_MARKER")
    if marker:
        with open(marker, "w") as output:
            output.write(type(source).__name__)
    return _Parsed()
`,
    "utf8",
  );
  await writeFile(join(urllibDir, "__init__.py"), "", "utf8");
  await writeFile(
    join(urllibDir, "error.py"),
    `class HTTPError(OSError):
    def __init__(self, url, code, message, headers):
        super().__init__(message)
        self.url = url
        self.code = code
        self.status = code
        self.headers = headers

    def close(self):
        pass
`,
    "utf8",
  );
  await writeFile(
    join(urllibDir, "parse.py"),
    `class _SplitResult:
    def __init__(self, scheme, netloc, path, query, fragment):
        self.scheme = scheme
        self.netloc = netloc
        self.path = path
        self.query = query
        self.fragment = fragment

    @property
    def hostname(self):
        host = self.netloc.rsplit("@", 1)[-1]
        if host.startswith("["):
            return host[1:].split("]", 1)[0].lower()
        return host.split(":", 1)[0].lower()

    @property
    def port(self):
        host = self.netloc.rsplit("@", 1)[-1]
        if host.startswith("["):
            suffix = host.split("]", 1)[1]
            return int(suffix[1:]) if suffix.startswith(":") else None
        suffix = host.split(":", 1)[1] if ":" in host else ""
        return int(suffix) if suffix else None

def urlsplit(value):
    scheme, remainder = value.split("://", 1)
    remainder, fragment = (remainder.split("#", 1) + [""])[:2] if "#" in remainder else (remainder, "")
    remainder, query = (remainder.split("?", 1) + [""])[:2] if "?" in remainder else (remainder, "")
    if "/" in remainder:
        netloc, path = remainder.split("/", 1)
        path = "/" + path
    else:
        netloc, path = remainder, ""
    return _SplitResult(scheme.lower(), netloc, path, query, fragment)

def urljoin(base, location):
    if location.startswith("http://") or location.startswith("https://"):
        return location
    if location.startswith("/"):
        scheme, remainder = base.split("://", 1)
        host = remainder.split("/", 1)[0]
        return scheme + "://" + host + location
    prefix = base.rsplit("/", 1)[0]
    return prefix + "/" + location
`,
    "utf8",
  );
  await writeFile(
    join(urllibDir, "request.py"),
    `import json
import os
from .error import HTTPError

class Request:
    def __init__(self, url, headers=None):
        self.full_url = url
        self.headers = headers or {}

class HTTPRedirectHandler:
    pass

class ProxyHandler:
    def __init__(self, proxies):
        self.proxies = proxies

class _Response:
    def __init__(self, route):
        self.status = route["status"]
        self.code = self.status
        self.headers = dict(route.get("headers", {}))
        if route.get("location") is not None:
            self.headers["Location"] = route["location"]
        self.body = (route.get("body") or "").encode("utf-8")
        if "Content-Length" not in self.headers:
            self.headers["Content-Length"] = str(len(self.body))

    def read(self, size=-1):
        if size < 0:
            size = len(self.body)
        chunk, self.body = self.body[:size], self.body[size:]
        return chunk

    def close(self):
        pass

class _Opener:
    def open(self, request, timeout=None):
        url = request.full_url
        routes_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "rss-routes.json",
        )
        with open(routes_path) as source:
            routes = json.load(source)
        route = routes.get(url)
        if route is None:
            raise OSError("missing RSS fixture route: " + url)
        log = os.environ.get("AGENT_REACH_RSS_REQUEST_LOG")
        if log:
            with open(log, "a") as output:
                output.write(url + "\\n")
        response = _Response(route)
        if response.status in (301, 302, 303, 307, 308):
            raise HTTPError(url, response.status, "redirect", response.headers)
        return response

def build_opener(*handlers):
    return _Opener()

def urlopen(*args, **kwargs):
    raise RuntimeError("fixture requires the controlled opener")
`,
    "utf8",
  );

  await writeFile(
    join(testDir, "rss-routes.json"),
    JSON.stringify(routes),
    "utf8",
  );
}
