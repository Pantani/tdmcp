<script setup lang="ts">
import { computed } from "vue";
import pkg from "../../../package.json";

const publicVersion = `v${pkg.version}`;

const props = withDefaults(
  defineProps<{
    status: "source-only" | "live-unverified";
    locale?: "en" | "pt";
  }>(),
  { locale: "en" },
);

const _copy = computed(() => {
  if (props.locale === "pt") {
    return props.status === "source-only"
      ? {
          title: "Disponível somente no código-fonte",
          body: `Esta capacidade faz parte da próxima versão e ainda não está no pacote público ${publicVersion}. Use somente um build deste checkout com o bridge correspondente; linhas marcadas UNVERIFIED continuam não verificadas.`,
        }
      : {
          title: "Validação live pendente",
          body: "O contrato offline passou, mas esta capacidade ainda precisa de evidência live no runtime indicado antes de uso em produção.",
        };
  }
  return props.status === "source-only"
    ? {
        title: "Source-tree only",
        body: `This capability belongs to the next release and is not in the public ${publicVersion} package. Use only a build from this checkout with its matching bridge; rows marked UNVERIFIED remain unverified.`,
      }
    : {
        title: "Live validation pending",
        body: "The offline contract passed, but this capability still needs live evidence on the named runtime before production use.",
      };
});
</script>

<template>
  <aside class="feature-availability" :data-status="status" role="note">
    <strong>{{ _copy.title }}</strong>
    <p>{{ _copy.body }}</p>
  </aside>
</template>

<style scoped>
.feature-availability {
  display: grid;
  gap: 0.35rem;
  margin: 1.25rem 0 1.5rem;
  padding: 0.9rem 1rem;
  border: 1px solid var(--vp-c-warning-2);
  border-left-width: 4px;
  border-radius: 8px;
  background: var(--vp-c-warning-soft);
}

.feature-availability strong,
.feature-availability p {
  margin: 0;
}
</style>
