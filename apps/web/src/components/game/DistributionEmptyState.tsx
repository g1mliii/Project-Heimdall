import { Card, Diagnostic } from "@heimdall/ui";

import styles from "./GamePageClient.module.css";

/**
 * Phase 7.0's only distribution state. This component is intentionally
 * prop-less and branch-free; a curve may be introduced only with Phase 7.5's
 * explicit comparability/cohort contract.
 */
export function DistributionEmptyState() {
  return (
    <Card className={styles.distributionCard}>
      <Card.Header title="Performance distribution" />
      <Card.Body>
        <Diagnostic severity="info" title="Insufficient comparable data">
          A distribution needs a cohort of comparable runs. Heimdall does not pool these
          individual submissions until that cohort contract is in place.
        </Diagnostic>
      </Card.Body>
    </Card>
  );
}
