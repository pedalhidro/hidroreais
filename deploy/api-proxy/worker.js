// dimdim-api.pedalhidrografi.co → the Cloud Run service. Cloud Run's own domain mapping isn't
// offered in southamerica-east1, so this Worker forwards requests as they are (method, headers,
// body; Origin stays, so the server's CORS check still applies) and returns the response.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    return fetch(new Request(new URL(url.pathname + url.search, env.ORIGIN_URL), request));
  },
};
