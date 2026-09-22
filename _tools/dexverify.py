import zipfile, os, re

os.chdir(r'C:\Users\25407\WorkBuddy\2026-09-16-17-45-17\douyin-nas')

z = zipfile.ZipFile('douyin-nas.apk')
dex = z.read('classes.dex')

MUST = [
    b'androidx/media3/exoplayer/ExoPlayer',
    b'androidx/media3/exoplayer/ExoPlayer$Builder',
    b'androidx/media3/exoplayer/DefaultRenderersFactory',
    b'androidx/media3/common/MediaItem',
    b'androidx/media3/common/Player$Listener',
    b'androidx/media3/common/PlaybackException',
    b'androidx/media3/common/VideoSize',
    b'androidx/media3/common/MimeTypes',
    b'androidx/media3/exoplayer/trackselection/DefaultTrackSelector',
    b'androidx/media3/ui/AspectRatioFrameLayout',
    b'androidx/media3/exoplayer/video/MediaCodecVideoRenderer',
    # NalUnitUtil 必须真的进来 —— 这就是 2.19.1 缺的那个类
    b'androidx/media3/container/NalUnitUtil',
    # 关键 extractor
    b'androidx/media3/extractor/avi/AviExtractor',
    b'androidx/media3/extractor/mp4/Mp4Extractor',
    b'androidx/media3/extractor/mkv/MatroskaExtractor',
    b'androidx/media3/extractor/flv/FlvExtractor',
    b'androidx/media3/extractor/ts/TsExtractor',
    b'androidx/media3/extractor/DefaultExtractorsFactory',
    # 运行期依赖
    b'com/google/common/collect/ImmutableList',
    b'com/google/common/base/Charsets',
    b'com/google/common/util/concurrent/Futures',
    b'androidx/collection/CircularIntArray',
    # 本项目的类
    b'com/nas/douyin/PlayerActivity',
    b'com/nas/douyin/MainActivity',
]

print('--- 必须存在的类 ---')
bad = []
for m in MUST:
    ok = m in dex
    if not ok:
        bad.append(m)
    print(('  OK   ' if ok else '  MISS ') + m.decode())

# 不该有的：老包名的任何残留
print()
print('--- 不该存在的（老 ExoPlayer 2.x） ---')
for m in [b'com/google/android/exoplayer2/ExoPlayer',
          b'com/google/android/exoplayer2/extractor/DefaultExtractorsFactory',
          b'com/nas/douyin/NasExtractorsFactory']:
    hit = m in dex
    print(('  BAD  ' if hit else '  ok   ') + m.decode() + ('  ← 还在！' if hit else ''))
    if hit:
        bad.append(m)

print()
print('dex 大小: %d B' % len(dex))
print('结论:', '全部通过' if not bad else ('缺/多: %s' % bad))
