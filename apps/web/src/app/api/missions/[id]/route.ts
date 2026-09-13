import { dashboardApi, dashboardErrorResponse } from "../../../../lib/api";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return Response.json(await dashboardApi.mission((await params).id));
  } catch (error) {
    return dashboardErrorResponse(error);
  }
}
