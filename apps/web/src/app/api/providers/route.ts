import { dashboardApi, dashboardErrorResponse } from "../../../lib/api";

export async function GET() {
  try {
    return Response.json(await dashboardApi.providers());
  } catch (error) {
    return dashboardErrorResponse(error);
  }
}
