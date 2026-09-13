#include <mgba/core/core.h>
#include <mgba-util/vfs.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
    if (argc < 4) {
        fprintf(stderr, "Usage: check-rom ROM OUTPUT_PREFIX frames:keys [...]\n");
        return 1;
    }
    struct mCore *core = mCoreFind(argv[1]);
    if (!core || !core->init(core)) return 2;
    mCoreInitConfig(core, "localization-test");
    color_t *pixels = calloc(240 * 160, sizeof(color_t));
    core->setVideoBuffer(core, pixels, 240);
    if (!mCoreLoadFile(core, argv[1])) return 3;
    core->reset(core);
    for (int stage = 3; stage < argc; stage++) {
        unsigned frames, keys;
        if (sscanf(argv[stage], "%u:%u", &frames, &keys) != 2) return 4;
        core->setKeys(core, keys);
        for (unsigned frame = 0; frame < frames; frame++) core->runFrame(core);
        char path[1024];
        snprintf(path, sizeof(path), "%s-%02d.png", argv[2], stage - 2);
        struct VFile *output = VFileOpen(path, O_WRONLY | O_CREAT | O_TRUNC);
        if (!output || !mCoreTakeScreenshotVF(core, output)) return 5;
        output->close(output);
        printf("%s frame=%u font=0x%08x script=0x%08x state=%u\n", path,
            core->frameCounter(core), core->busRead32(core, 0x02031ee8),
            core->busRead32(core, 0x020347c4), core->busRead32(core, 0x020347c0));
    }
    core->deinit(core);
    free(pixels);
    return 0;
}