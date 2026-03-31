import serverless from "serverless-http";
import app from "../../src/app.js";

const fn = serverless(app, {
  basePath: "/.netlify/functions"
});

export const handler = async (event, context) => {
  try {
    return await fn(event, context);
  } catch (error) {
    console.error("Netlify function initialization/runtime error:", error);
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        error: "Function failed to initialize. Check Netlify Function logs and env vars."
      })
    };
  }
};
