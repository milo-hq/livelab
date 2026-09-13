#!/bin/sh
# Pushes a synthetic test stream (no media file needed) to an RTMP server.
# The wall clock is burned into the picture so glass-to-glass latency can be read off the screen.
# Three renditions are produced so ABR can be demonstrated: demo (main), demo_720, demo_360.
# The filter graph lives in filter.txt (loaded with FFmpeg 7+ `-/filter_complex FILE`) to avoid
# shell/ffmpeg double-escaping of the ':' characters inside drawtext.
set -e
TARGET=${TARGET:-rtmp://mediamtx:1935/live}
V="-c:v libx264 -preset veryfast -tune zerolatency -profile:v main -g 30 -keyint_min 30 -sc_threshold 0 -pix_fmt yuv420p"
A="-c:a aac -ar 48000"

exec ffmpeg -hide_banner -loglevel warning -re \
  -f lavfi -i "testsrc2=size=1280x720:rate=30" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000" \
  -/filter_complex /filter.txt \
  -map "[vmain]" -map 1:a $V -b:v 2500k -maxrate 2500k -bufsize 5000k $A -b:a 128k -f flv "$TARGET/demo" \
  -map "[v720]"  -map 1:a $V -b:v 2500k -maxrate 2500k -bufsize 5000k $A -b:a 128k -f flv "$TARGET/demo_720" \
  -map "[v360s]" -map 1:a $V -b:v 700k  -maxrate 700k  -bufsize 1400k $A -b:a 64k  -f flv "$TARGET/demo_360"
