import { dashboardApi, dashboardErrorResponse } from "../../../../lib/api";

export async function GET(request: Request) {
  const url = new URL(request.url);
  try {
    return Response.json(await dashboardApi.rankedProviders({
      capability: url.searchParams.get("capability") ?? "",
      maxPriceTinybar: url.searchParams.get("maxPriceTinybar") ?? "",
    }));
  } catch (error) {
    return dashboardErrorResponse(error);
  }
}
