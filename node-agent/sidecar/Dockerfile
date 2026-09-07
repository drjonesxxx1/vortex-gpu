# VortexGPU per-session egress sidecar.
#
# This container owns the network namespace that a tenant desktop is attached to
# with `--network=container:<this>`. It holds the only NET_ADMIN in that
# namespace, so the rules it installs are the rules the tenant lives under.
#
# Built locally on the node (see docs/EGRESS.md) rather than pulled from a
# third-party registry: the whole point of this container is that its contents
# are trusted, and a random public "redsocks" image is not.
FROM debian:bookworm-slim

# redsocks   - transparent TCP -> SOCKS5/HTTP-CONNECT redirector, plus its
#              `dnstc` responder which answers every UDP DNS query with TC=1 so
#              resolvers retry over TCP and get tunnelled.
# tinyproxy  - local HTTP proxy on 127.0.0.1:3128, the "belt" that the injected
#              HTTP_PROXY/ALL_PROXY env vars point at.
# iptables   - Debian's iptables is the nft backend, which matches the nftables
#              host kernel on nightmare.
# curl       - used by the pre-flight egress verification and the LAN probe.
# util-linux - setpriv, to run redsocks under an unprivileged uid.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      redsocks tinyproxy iptables curl ca-certificates util-linux iproute2 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --no-create-home --shell /usr/sbin/nologin redsocks || true

COPY entrypoint.sh /usr/local/bin/vortex-sidecar
COPY firewall.sh /usr/local/bin/vortex-firewall
COPY verify-egress.sh /usr/local/bin/vortex-verify
COPY probe-lan.sh /usr/local/bin/vortex-probe-lan
RUN chmod 0755 /usr/local/bin/vortex-sidecar /usr/local/bin/vortex-firewall \
                /usr/local/bin/vortex-verify /usr/local/bin/vortex-probe-lan

ENTRYPOINT ["/usr/local/bin/vortex-sidecar"]
