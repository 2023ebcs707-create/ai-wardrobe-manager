import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { HealthResponse } from '@wardrobe/shared';
import { color, space } from '../theme/tokens';
import { text } from '../theme/type';
import { Pip, Row } from '../theme/ui';

/** The four keys of `HealthResponse`, in the order the API answers them. */
const SERVICES = ['api', 'database', 'storage', 'ai'] as const;

/**
 * Which services are up, on the Profile screen.
 *
 * Reads the body regardless of the status code, deliberately: the API answers
 * HTTP 503 with a perfectly valid JSON body when one dependency is down, so
 * checking `res.ok` first would turn "storage is down" into "unreachable" and
 * throw away the one thing this panel exists to say.
 */
export function HealthBanner({ baseUrl }: { baseUrl: string }) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetch(`${baseUrl}/health`)
      .then((res) => res.json())
      .then((body: HealthResponse) => {
        if (!cancelled) setHealth(body);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [baseUrl]);

  if (failed) {
    return (
      <Text testID="health-error" style={styles.error}>
        Cannot reach the server.
      </Text>
    );
  }

  if (!health) {
    return (
      <Text testID="health-loading" style={styles.checking}>
        Checking services…
      </Text>
    );
  }

  return (
    <View testID="health-banner">
      {SERVICES.map((service, index) => (
        <Row
          key={service}
          testID={`health-${service}`}
          first={index === 0}
          // The status is in the row's own text, not only in the pip beside
          // it: a green dot and a red dot are the same dot in greyscale, and
          // this panel's whole job is to be read at a glance by someone who
          // suspects something is broken.
          name={`${service}: ${health[service]}`}
          trailing={<Pip hex={health[service] === 'ok' ? color.sage : color.washInk} size={8} />}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  error: { ...text.body, fontSize: 13.5, color: color.washInk, paddingVertical: space.md },
  checking: { ...text.meta, paddingVertical: space.md },
});
