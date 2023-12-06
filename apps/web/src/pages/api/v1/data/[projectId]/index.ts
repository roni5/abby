import { NextApiRequest, NextApiResponse } from "next";
import { z } from "zod";
import { prisma } from "server/db/client";
import NextCors from "nextjs-cors";
import { ABBY_WINDOW_KEY, AbbyDataResponse } from "@tryabby/core";
import { EventService } from "server/services/EventService";
import { trackPlanOverage } from "lib/logsnag";
import { RequestCache } from "server/services/RequestCache";
import { transformFlagValue } from "lib/flags";
import { RequestService } from "server/services/RequestService";

const incomingQuerySchema = z.object({
  projectId: z.string().transform((v) => v.replace(/.js$/, "")),
  environment: z.string(),
});

export default async function getWeightsHandler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const now = performance.now();

  await NextCors(req, res, {
    methods: ["GET"],
    origin: "*",
    optionsSuccessStatus: 200,
  });

  const querySchemaResult = incomingQuerySchema.safeParse(req.query);
  if (!querySchemaResult.success) {
    res.status(400).json({ error: "Invalid query" });
    return;
  }

  const { projectId, environment } = querySchemaResult.data;

  try {
    const { events, planLimits, plan, is80PercentOfLimit } =
      await EventService.getEventsForCurrentPeriod(projectId);

    if (events > planLimits.eventsPerMonth) {
      res.status(429).json({ error: "Plan limit reached" });
      // TODO: send email
      // TODO: send email if 80% of limit reached
      await trackPlanOverage(projectId, plan);
      return;
    }

    const [tests, flags] = await Promise.all([
      prisma.test.findMany({
        where: {
          projectId,
        },
        include: { options: true },
      }),
      prisma.featureFlagValue.findMany({
        where: {
          environment: {
            name: environment,
            projectId,
          },
        },
        include: { flag: { select: { name: true, type: true } } },
      }),
    ]);

    const response = {
      tests: tests.map((test) => ({
        name: test.name,
        weights: test.options.map((o) => o.chance.toNumber()),
      })),
      flags: flags
        .filter(({ flag }) => flag.type === "BOOLEAN")
        .map((flagValue) => {
          return {
            name: flagValue.flag.name,
            value: transformFlagValue(flagValue.value, flagValue.flag.type),
          };
        }),
      remoteConfig: flags
        .filter(({ flag }) => flag.type !== "BOOLEAN")
        .map((flagValue) => {
          return {
            name: flagValue.flag.name,
            value: transformFlagValue(flagValue.value, flagValue.flag.type),
          };
        }),
    } satisfies AbbyDataResponse;

    const duration = performance.now() - now;

    if (
      typeof req.query.projectId === "string" &&
      req.query.projectId.endsWith(".js")
    ) {
      const jsContent = `window.${ABBY_WINDOW_KEY} = ${JSON.stringify(
        response
      )}`;

      res.setHeader("Content-Type", "application/javascript");

      res.send(jsContent);
    }

    res.json(response);

    if (is80PercentOfLimit) {
      await trackPlanOverage(projectId, plan, is80PercentOfLimit);
    }

    await RequestCache.increment(projectId);

    RequestService.storeRequest({
      projectId,
      type: "GET_CONFIG",
      durationInMs: duration,
    }).catch((e) => {
      console.error("Unable to store request", e);
    });

    return;
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal server error" });
  }
}