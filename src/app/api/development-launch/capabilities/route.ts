import { getDevelopmentLaunchService } from "@/lib/development-launch/service";
import { unsupportedDevelopmentCapabilities } from "@/lib/development-launch/platform";
import { developmentLaunchErrorResponse, getLaunchNonceStore } from "@/lib/development-launch/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json({
      ...await getDevelopmentLaunchService().capabilities(),
      nonce: getLaunchNonceStore().issue(),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNSUPPORTED_PLATFORM") {
      return Response.json({
        ...unsupportedDevelopmentCapabilities(process.platform),
        nonce: getLaunchNonceStore().issue(),
      });
    }
    return developmentLaunchErrorResponse(error);
  }
}
