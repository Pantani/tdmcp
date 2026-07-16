import DefaultTheme from "vitepress/theme";
import FeatureAvailability from "./FeatureAvailability.vue";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("FeatureAvailability", FeatureAvailability);
  },
};
