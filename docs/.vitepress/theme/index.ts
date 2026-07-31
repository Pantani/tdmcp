import DefaultTheme from "vitepress/theme";
import { installTdmcpWebMcp } from "../../../src/docs/webMcp.js";
import FeatureAvailability from "./FeatureAvailability.vue";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("FeatureAvailability", FeatureAvailability);
    void installTdmcpWebMcp().catch(() => undefined);
  },
};
