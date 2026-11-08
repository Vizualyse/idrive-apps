// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
//
// vkprobe STAGE: vk-trial's child. Goes through the stages in order and
// stops after STAGE, so each try on the car goes one step further than the
// last one that came back:
//
//   instance   the loader and the driver load, an instance (no device yet)
//   enumerate  the physical device: ANV opens the render node and asks the
//              kernel its parameters (and makes a test context)
//   device     a logical device and its queue: a GPU context
//   compute    a compute shader on 1024 numbers, submitted and waited for
//              (5 s), the result checked on the CPU
//   draw       offscreen: a render pass clears a 256x256 tiled image, a
//              graphics pipeline draws one triangle coloured by position,
//              the image is copied into a buffer and every pixel checked
//   present    on a window: starts bin/wl-sink (the Steam tool's
//              compositor) in a private /tmp folder, opens an xdg_toplevel
//              on it, a FIFO swapchain (VK_KHR_wayland_surface), 60 frames
//              of the triangle; then wl-sink's counts (pictures, GPU
//              buffers) and its last picture checked pixel by pixel. Only
//              this stage enables the window-system extensions
//
// Never asks for VK_KHR_display (that would open the display node). Each
// stage leaves a crumb (vk_crumbs.so) before and after. On the bench's stub
// GPU nothing runs, so the numbers come back unchanged: accepted there
// (INTEL_STUB_GPU_PLATFORM set) as "not run".

#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>
#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"
#define VK_USE_PLATFORM_WAYLAND_KHR
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vulkan/vulkan.h>
#include "shaders.spv.h"

#define COUNT 1024

static void (*crumb_fn)(const char *, ...);
#define CRUMB(...) do { if (crumb_fn) crumb_fn(__VA_ARGS__); } while (0)

static int stop_after;
static const char *NAMES[] = { "instance", "enumerate", "device", "compute", "draw", "present" };

static void say(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vprintf(fmt, ap);
    va_end(ap);
    printf("\n");
    fflush(stdout);
}

#define CHECK(call) do { VkResult r_ = (call); if (r_ != VK_SUCCESS) { \
    say("FAIL %s = %d", #call, (int)r_); CRUMB("probe: FAIL %s = %d", #call, (int)r_); return 1; } } while (0)

static void begin(int s) { CRUMB("probe: stage %s begins", NAMES[s]); say("stage %s ...", NAMES[s]); }
static int end(int s) { CRUMB("probe: stage %s done", NAMES[s]); say("stage %s: ok", NAMES[s]); return s >= stop_after; }

static int compute(VkPhysicalDevice pd, VkDevice dev, VkQueue q, uint32_t family) {
    VkPhysicalDeviceMemoryProperties mp;
    vkGetPhysicalDeviceMemoryProperties(pd, &mp);
    VkBufferCreateInfo bi = { VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO, 0, 0, COUNT * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT, VK_SHARING_MODE_EXCLUSIVE, 0, 0 };
    VkBuffer buf;
    CHECK(vkCreateBuffer(dev, &bi, 0, &buf));
    VkMemoryRequirements mr;
    vkGetBufferMemoryRequirements(dev, buf, &mr);
    uint32_t want = VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT, type = UINT32_MAX;
    for (uint32_t i = 0; i < mp.memoryTypeCount; i++)
        if ((mr.memoryTypeBits & (1u << i)) && (mp.memoryTypes[i].propertyFlags & want) == want) { type = i; break; }
    if (type == UINT32_MAX) { say("FAIL no host-visible coherent memory"); return 1; }
    VkMemoryAllocateInfo ai = { VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, 0, mr.size, type };
    VkDeviceMemory mem;
    CHECK(vkAllocateMemory(dev, &ai, 0, &mem));
    CHECK(vkBindBufferMemory(dev, buf, mem, 0));
    uint32_t *v;
    CHECK(vkMapMemory(dev, mem, 0, COUNT * 4, 0, (void **)&v));
    for (uint32_t i = 0; i < COUNT; i++) v[i] = i;

    VkShaderModuleCreateInfo si = { VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO, 0, 0, sizeof compute_comp_spv, compute_comp_spv };
    VkShaderModule sm;
    CHECK(vkCreateShaderModule(dev, &si, 0, &sm));
    VkDescriptorSetLayoutBinding lb = { 0, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT, 0 };
    VkDescriptorSetLayoutCreateInfo li = { VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO, 0, 0, 1, &lb };
    VkDescriptorSetLayout dsl;
    CHECK(vkCreateDescriptorSetLayout(dev, &li, 0, &dsl));
    VkPipelineLayoutCreateInfo pli = { VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, 0, 0, 1, &dsl, 0, 0 };
    VkPipelineLayout pl;
    CHECK(vkCreatePipelineLayout(dev, &pli, 0, &pl));
    VkComputePipelineCreateInfo cpi = { VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO, 0, 0,
        { VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, 0, 0, VK_SHADER_STAGE_COMPUTE_BIT, sm, "main", 0 }, pl, 0, -1 };
    VkPipeline pipe;
    CRUMB("probe: compiling the compute shader");
    CHECK(vkCreateComputePipelines(dev, 0, 1, &cpi, 0, &pipe));
    VkDescriptorPoolSize ps = { VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1 };
    VkDescriptorPoolCreateInfo dpi = { VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, 0, 0, 1, 1, &ps };
    VkDescriptorPool dp;
    CHECK(vkCreateDescriptorPool(dev, &dpi, 0, &dp));
    VkDescriptorSetAllocateInfo dai = { VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO, 0, dp, 1, &dsl };
    VkDescriptorSet ds;
    CHECK(vkAllocateDescriptorSets(dev, &dai, &ds));
    VkDescriptorBufferInfo dbi = { buf, 0, VK_WHOLE_SIZE };
    VkWriteDescriptorSet w = { VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, 0, ds, 0, 0, 1, VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 0, &dbi, 0 };
    vkUpdateDescriptorSets(dev, 1, &w, 0, 0);

    VkCommandPoolCreateInfo cpci = { VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO, 0, 0, family };
    VkCommandPool cp;
    CHECK(vkCreateCommandPool(dev, &cpci, 0, &cp));
    VkCommandBufferAllocateInfo cbai = { VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO, 0, cp, VK_COMMAND_BUFFER_LEVEL_PRIMARY, 1 };
    VkCommandBuffer cb;
    CHECK(vkAllocateCommandBuffers(dev, &cbai, &cb));
    VkCommandBufferBeginInfo cbbi = { VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO, 0, VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT, 0 };
    CHECK(vkBeginCommandBuffer(cb, &cbbi));
    vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_COMPUTE, pipe);
    vkCmdBindDescriptorSets(cb, VK_PIPELINE_BIND_POINT_COMPUTE, pl, 0, 1, &ds, 0, 0);
    vkCmdDispatch(cb, COUNT / 64, 1, 1);
    VkMemoryBarrier mb = { VK_STRUCTURE_TYPE_MEMORY_BARRIER, 0, VK_ACCESS_SHADER_WRITE_BIT, VK_ACCESS_HOST_READ_BIT };
    vkCmdPipelineBarrier(cb, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_PIPELINE_STAGE_HOST_BIT, 0, 1, &mb, 0, 0, 0, 0);
    CHECK(vkEndCommandBuffer(cb));
    VkFenceCreateInfo fi = { VK_STRUCTURE_TYPE_FENCE_CREATE_INFO, 0, 0 };
    VkFence f;
    CHECK(vkCreateFence(dev, &fi, 0, &f));
    VkSubmitInfo sub = { VK_STRUCTURE_TYPE_SUBMIT_INFO, 0, 0, 0, 0, 1, &cb, 0, 0 };
    CRUMB("probe: submitting");
    CHECK(vkQueueSubmit(q, 1, &sub, f));
    CRUMB("probe: waiting (5 s at most)");
    CHECK(vkWaitForFences(dev, 1, &f, VK_TRUE, 5000000000ull));

    int right = 0, unchanged = 0;
    for (uint32_t i = 0; i < COUNT; i++) { right += v[i] == i * 3 + 7; unchanged += v[i] == i; }
    say("compute: %d of %d right, %d unchanged", right, COUNT, unchanged);
    CRUMB("probe: compute %d right, %d unchanged", right, unchanged);
    int ok = right == COUNT || (unchanged == COUNT && getenv("INTEL_STUB_GPU_PLATFORM"));
    if (right != COUNT && ok) say("compute: not run (the bench's stub GPU runs nothing): accepted on the bench only");

    vkDestroyFence(dev, f, 0);
    vkDestroyCommandPool(dev, cp, 0);
    vkDestroyDescriptorPool(dev, dp, 0);
    vkDestroyPipeline(dev, pipe, 0);
    vkDestroyPipelineLayout(dev, pl, 0);
    vkDestroyDescriptorSetLayout(dev, dsl, 0);
    vkDestroyShaderModule(dev, sm, 0);
    vkUnmapMemory(dev, mem);
    vkFreeMemory(dev, mem, 0);
    vkDestroyBuffer(dev, buf, 0);
    return ok ? 0 : 1;
}

/* ---- draw: a triangle into an image, offscreen, every pixel checked ---------- */

#define W 256
#define CLEAR_B 255
#define FILL 0xAB   /* the read-back buffer before: still there = nothing written */

static uint32_t mem_type(VkPhysicalDeviceMemoryProperties *mp, uint32_t bits, VkMemoryPropertyFlags want) {
    for (uint32_t i = 0; i < mp->memoryTypeCount; i++)
        if ((bits & (1u << i)) && (mp->memoryTypes[i].propertyFlags & want) == want) return i;
    return UINT32_MAX;
}

/* What pixel (x, y) must be: the triangle (-1,-1) (1,-1) (-1,1) covers the
 * pixel centres with x + y + 1 < W; on x + y + 1 == W (the edge) either is
 * right; inside, draw.frag's (x+0.5)/256, (y+0.5)/256 in UNORM (±1). */
static int pixel_ok(uint32_t x, uint32_t y, const uint8_t *p, int *inside) {
    *inside = x + y + 1 < W;
    if (x + y + 1 == W) { *inside = -1; return 1; }
    if (!*inside) return p[0] == 0 && p[1] == 0 && p[2] == CLEAR_B && p[3] == 255;
    int r = (int)((x + 0.5) / 256.0 * 255.0 + 0.5), g = (int)((y + 0.5) / 256.0 * 255.0 + 0.5);
    return abs(p[0] - r) <= 1 && abs(p[1] - g) <= 1 && p[2] == 0 && p[3] == 255;
}

static int draw(VkPhysicalDevice pd, VkDevice dev, VkQueue q, uint32_t family) {
    VkPhysicalDeviceMemoryProperties mp;
    vkGetPhysicalDeviceMemoryProperties(pd, &mp);
    const VkFormat fmt = VK_FORMAT_R8G8B8A8_UNORM;

    /* the image, on the GPU's own layout (tiled) */
    VkImageCreateInfo ii = { VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, 0, 0, VK_IMAGE_TYPE_2D, fmt, { W, W, 1 }, 1, 1,
        VK_SAMPLE_COUNT_1_BIT, VK_IMAGE_TILING_OPTIMAL, VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT,
        VK_SHARING_MODE_EXCLUSIVE, 0, 0, VK_IMAGE_LAYOUT_UNDEFINED };
    VkImage img;
    CHECK(vkCreateImage(dev, &ii, 0, &img));
    VkMemoryRequirements ir;
    vkGetImageMemoryRequirements(dev, img, &ir);
    uint32_t it = mem_type(&mp, ir.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
    if (it == UINT32_MAX) { say("FAIL no memory for the image"); return 1; }
    VkMemoryAllocateInfo iai = { VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, 0, ir.size, it };
    VkDeviceMemory imem;
    CHECK(vkAllocateMemory(dev, &iai, 0, &imem));
    CHECK(vkBindImageMemory(dev, img, imem, 0));
    VkImageViewCreateInfo vi = { VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, 0, 0, img, VK_IMAGE_VIEW_TYPE_2D, fmt,
        { VK_COMPONENT_SWIZZLE_IDENTITY, VK_COMPONENT_SWIZZLE_IDENTITY, VK_COMPONENT_SWIZZLE_IDENTITY, VK_COMPONENT_SWIZZLE_IDENTITY },
        { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 } };
    VkImageView view;
    CHECK(vkCreateImageView(dev, &vi, 0, &view));

    /* the read-back buffer */
    VkBufferCreateInfo bi = { VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO, 0, 0, W * W * 4, VK_BUFFER_USAGE_TRANSFER_DST_BIT, VK_SHARING_MODE_EXCLUSIVE, 0, 0 };
    VkBuffer buf;
    CHECK(vkCreateBuffer(dev, &bi, 0, &buf));
    VkMemoryRequirements br;
    vkGetBufferMemoryRequirements(dev, buf, &br);
    uint32_t bt = mem_type(&mp, br.memoryTypeBits, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
    if (bt == UINT32_MAX) { say("FAIL no host-visible memory"); return 1; }
    VkMemoryAllocateInfo bai = { VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, 0, br.size, bt };
    VkDeviceMemory bmem;
    CHECK(vkAllocateMemory(dev, &bai, 0, &bmem));
    CHECK(vkBindBufferMemory(dev, buf, bmem, 0));
    uint8_t *px;
    CHECK(vkMapMemory(dev, bmem, 0, W * W * 4, 0, (void **)&px));
    memset(px, FILL, W * W * 4);

    /* render pass: clear to blue, draw, leave it ready to copy */
    VkAttachmentDescription ad = { 0, fmt, VK_SAMPLE_COUNT_1_BIT, VK_ATTACHMENT_LOAD_OP_CLEAR, VK_ATTACHMENT_STORE_OP_STORE,
        VK_ATTACHMENT_LOAD_OP_DONT_CARE, VK_ATTACHMENT_STORE_OP_DONT_CARE, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL };
    VkAttachmentReference ar = { 0, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL };
    VkSubpassDescription sd = { 0, VK_PIPELINE_BIND_POINT_GRAPHICS, 0, 0, 1, &ar, 0, 0, 0, 0 };
    VkSubpassDependency dep = { 0, VK_SUBPASS_EXTERNAL, VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT,
        VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT, VK_ACCESS_TRANSFER_READ_BIT, 0 };
    VkRenderPassCreateInfo rpi = { VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO, 0, 0, 1, &ad, 1, &sd, 1, &dep };
    VkRenderPass rp;
    CHECK(vkCreateRenderPass(dev, &rpi, 0, &rp));
    VkFramebufferCreateInfo fbi = { VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO, 0, 0, rp, 1, &view, W, W, 1 };
    VkFramebuffer fb;
    CHECK(vkCreateFramebuffer(dev, &fbi, 0, &fb));

    /* the pipeline: no vertex input, the whole image */
    VkShaderModuleCreateInfo vsi = { VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO, 0, 0, sizeof draw_vert_spv, draw_vert_spv };
    VkShaderModuleCreateInfo fsi = { VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO, 0, 0, sizeof draw_frag_spv, draw_frag_spv };
    VkShaderModule vs, fs;
    CHECK(vkCreateShaderModule(dev, &vsi, 0, &vs));
    CHECK(vkCreateShaderModule(dev, &fsi, 0, &fs));
    VkPipelineShaderStageCreateInfo stages[2] = {
        { VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, 0, 0, VK_SHADER_STAGE_VERTEX_BIT, vs, "main", 0 },
        { VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, 0, 0, VK_SHADER_STAGE_FRAGMENT_BIT, fs, "main", 0 } };
    VkPipelineVertexInputStateCreateInfo vin = { VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO, 0, 0, 0, 0, 0, 0 };
    VkPipelineInputAssemblyStateCreateInfo ia = { VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO, 0, 0, VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST, VK_FALSE };
    VkViewport vp = { 0, 0, W, W, 0, 1 };
    VkRect2D sc = { { 0, 0 }, { W, W } };
    VkPipelineViewportStateCreateInfo vps = { VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO, 0, 0, 1, &vp, 1, &sc };
    VkPipelineRasterizationStateCreateInfo rs = { VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO, 0, 0, VK_FALSE, VK_FALSE,
        VK_POLYGON_MODE_FILL, VK_CULL_MODE_NONE, VK_FRONT_FACE_COUNTER_CLOCKWISE, VK_FALSE, 0, 0, 0, 1.0f };
    VkPipelineMultisampleStateCreateInfo ms = { VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO, 0, 0, VK_SAMPLE_COUNT_1_BIT, VK_FALSE, 0, 0, VK_FALSE, VK_FALSE };
    VkPipelineColorBlendAttachmentState cba = { VK_FALSE, 0, 0, 0, 0, 0, 0,
        VK_COLOR_COMPONENT_R_BIT | VK_COLOR_COMPONENT_G_BIT | VK_COLOR_COMPONENT_B_BIT | VK_COLOR_COMPONENT_A_BIT };
    VkPipelineColorBlendStateCreateInfo cb = { VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO, 0, 0, VK_FALSE, 0, 1, &cba, { 0, 0, 0, 0 } };
    VkPipelineLayoutCreateInfo pli = { VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, 0, 0, 0, 0, 0, 0 };
    VkPipelineLayout pl;
    CHECK(vkCreatePipelineLayout(dev, &pli, 0, &pl));
    VkGraphicsPipelineCreateInfo gpi = { VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO, 0, 0, 2, stages, &vin, &ia, 0, &vps, &rs, &ms, 0, &cb, 0,
        pl, rp, 0, 0, -1 };
    VkPipeline pipe;
    CRUMB("probe: compiling the draw shaders");
    CHECK(vkCreateGraphicsPipelines(dev, 0, 1, &gpi, 0, &pipe));

    /* record: the pass, then the image into the buffer */
    VkCommandPoolCreateInfo cpci = { VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO, 0, 0, family };
    VkCommandPool cp;
    CHECK(vkCreateCommandPool(dev, &cpci, 0, &cp));
    VkCommandBufferAllocateInfo cbai = { VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO, 0, cp, VK_COMMAND_BUFFER_LEVEL_PRIMARY, 1 };
    VkCommandBuffer cmd;
    CHECK(vkAllocateCommandBuffers(dev, &cbai, &cmd));
    VkCommandBufferBeginInfo cbbi = { VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO, 0, VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT, 0 };
    CHECK(vkBeginCommandBuffer(cmd, &cbbi));
    VkClearValue clear = { .color = { .float32 = { 0.0f, 0.0f, CLEAR_B / 255.0f, 1.0f } } };
    VkRenderPassBeginInfo rpb = { VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO, 0, rp, fb, { { 0, 0 }, { W, W } }, 1, &clear };
    vkCmdBeginRenderPass(cmd, &rpb, VK_SUBPASS_CONTENTS_INLINE);
    vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pipe);
    vkCmdDraw(cmd, 3, 1, 0, 0);
    vkCmdEndRenderPass(cmd);
    VkBufferImageCopy copy = { 0, 0, 0, { VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 }, { 0, 0, 0 }, { W, W, 1 } };
    vkCmdCopyImageToBuffer(cmd, img, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, buf, 1, &copy);
    VkMemoryBarrier mb = { VK_STRUCTURE_TYPE_MEMORY_BARRIER, 0, VK_ACCESS_TRANSFER_WRITE_BIT, VK_ACCESS_HOST_READ_BIT };
    vkCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_HOST_BIT, 0, 1, &mb, 0, 0, 0, 0);
    CHECK(vkEndCommandBuffer(cmd));
    VkFenceCreateInfo fi = { VK_STRUCTURE_TYPE_FENCE_CREATE_INFO, 0, 0 };
    VkFence f;
    CHECK(vkCreateFence(dev, &fi, 0, &f));
    VkSubmitInfo sub = { VK_STRUCTURE_TYPE_SUBMIT_INFO, 0, 0, 0, 0, 1, &cmd, 0, 0 };
    CRUMB("probe: submitting the draw");
    CHECK(vkQueueSubmit(q, 1, &sub, f));
    CRUMB("probe: waiting (5 s at most)");
    CHECK(vkWaitForFences(dev, 1, &f, VK_TRUE, 5000000000ull));

    /* every pixel */
    int right = 0, wrong = 0, untouched = 0, in = 0, out = 0, edge = 0;
    uint32_t first_bad = UINT32_MAX;
    for (uint32_t y = 0; y < W; y++)
        for (uint32_t x = 0; x < W; x++) {
            const uint8_t *p = px + (y * W + x) * 4;
            int inside;
            untouched += p[0] == FILL && p[1] == FILL && p[2] == FILL && p[3] == FILL;
            if (pixel_ok(x, y, p, &inside)) { right++; if (inside == 1) in++; else if (inside == 0) out++; else edge++; }
            else { wrong++; if (first_bad == UINT32_MAX) first_bad = y * W + x; }
        }
    say("draw: %d of %d pixels right (%d in the triangle, %d cleared, %d on its edge), %d wrong, %d untouched",
        right, W * W, in, out, edge, wrong, untouched);
    if (first_bad != UINT32_MAX) {
        const uint8_t *p = px + first_bad * 4;
        say("draw: first wrong pixel (%u,%u) = %u %u %u %u", first_bad % W, first_bad / W, p[0], p[1], p[2], p[3]);
    }
    CRUMB("probe: draw %d right, %d wrong, %d untouched", right, wrong, untouched);
    int ok = wrong == 0 || (untouched == W * W && getenv("INTEL_STUB_GPU_PLATFORM"));
    if (wrong && ok) say("draw: not run (the bench's stub GPU runs nothing): accepted on the bench only");

    vkDestroyFence(dev, f, 0);
    vkDestroyCommandPool(dev, cp, 0);
    vkDestroyPipeline(dev, pipe, 0);
    vkDestroyPipelineLayout(dev, pl, 0);
    vkDestroyShaderModule(dev, vs, 0);
    vkDestroyShaderModule(dev, fs, 0);
    vkDestroyFramebuffer(dev, fb, 0);
    vkDestroyRenderPass(dev, rp, 0);
    vkUnmapMemory(dev, bmem);
    vkFreeMemory(dev, bmem, 0);
    vkDestroyBuffer(dev, buf, 0);
    vkDestroyImageView(dev, view, 0);
    vkFreeMemory(dev, imem, 0);
    vkDestroyImage(dev, img, 0);
    return ok ? 0 : 1;
}

/* ---- present: frames to a Wayland compositor (our wl-sink), checked there ---- */

#define FRAMES 60

static struct {
    pid_t pid;
    int out;                      /* its stdout */
    char dir[64], snap[96];
    char line[512];
    long pictures, drm, shm;
} sink;

/* one line of wl-sink's stdout within ms; 1 = got one, 0 = none */
static int sink_line(int ms) {
    size_t n = 0;
    for (;;) {
        struct pollfd pf = { sink.out, POLLIN, 0 };
        if (poll(&pf, 1, ms) <= 0) return 0;
        char c;
        if (read(sink.out, &c, 1) != 1) return 0;
        if (c == '\n') { sink.line[n] = 0; return 1; }
        if (n < sizeof sink.line - 1) sink.line[n++] = c;
    }
}

static long jnum(const char *line, const char *key) {
    char k[40];
    snprintf(k, sizeof k, "\"%s\":", key);
    const char *p = strstr(line, k);
    return p ? atol(p + strlen(k)) : -1;
}

/* wl-sink next to us (bin/wl-sink), in a private folder under /tmp: its
 * socket, a 256x256 frame file and the snapshot of each picture */
static int sink_start(const char *self) {
    snprintf(sink.dir, sizeof sink.dir, "/tmp/vkprobe-XXXXXX");
    if (!mkdtemp(sink.dir)) { say("FAIL mkdtemp: %s", strerror(errno)); return -1; }
    snprintf(sink.snap, sizeof sink.snap, "%s/snap.ppm", sink.dir);
    char bin[512], frame[96];
    snprintf(bin, sizeof bin, "%s", self);
    char *s = strrchr(bin, '/');
    snprintf(s ? s + 1 : bin, sizeof bin - (size_t)(s ? s + 1 - bin : 0), "wl-sink");
    snprintf(frame, sizeof frame, "%s/frame", sink.dir);
    setenv("XDG_RUNTIME_DIR", sink.dir, 1);
    /* lib/mesa (build.sh): the ANV packed. Mesa 20+'s WSI wants
     * linux-dmabuf (no wl_drm); 19's keeps the proven wl_drm path */
    int dmabuf = 0;
    {
        char mf[512];
        snprintf(mf, sizeof mf, "%s", bin);
        char *b = strrchr(mf, '/');
        if (b) { *b = 0; b = strrchr(mf, '/'); }
        if (b) {
            snprintf(b, sizeof mf - (size_t)(b - mf), "/lib/mesa");
            FILE *f = fopen(mf, "r");
            int major = 0;
            if (f) { if (fscanf(f, "%d", &major) != 1) major = 0; fclose(f); }
            dmabuf = major >= 20;
        }
    }
    int p[2];
    if (pipe(p) < 0) return -1;
    sink.pid = fork();
    if (sink.pid < 0) return -1;
    if (sink.pid == 0) {
        dup2(p[1], 1);
        close(p[0]);
        if (dmabuf) execl(bin, bin, "--socket", "vkprobe-0", "--frame", frame, "--create", "256x256", "--snap", sink.snap, "--dmabuf", (char *)0);
        else execl(bin, bin, "--socket", "vkprobe-0", "--frame", frame, "--create", "256x256", "--snap", sink.snap, (char *)0);
        _exit(127);
    }
    close(p[1]);
    sink.out = p[0];
    while (sink_line(5000)) {
        if (strstr(sink.line, "\"ev\":\"ready\"")) { say("sink: %s", sink.line); return 0; }
        if (strstr(sink.line, "\"ev\":\"error\"")) break;
    }
    say("FAIL wl-sink (%s) did not start: %s", bin, sink.line);
    return -1;
}

static void sink_stop(void) {
    if (sink.pid > 0) { kill(sink.pid, SIGTERM); waitpid(sink.pid, NULL, 0); sink.pid = 0; }
    char p[128];
    snprintf(p, sizeof p, "%s/frame", sink.dir); unlink(p);
    unlink(sink.snap);
    snprintf(p, sizeof p, "%s/vkprobe-0", sink.dir); unlink(p);
    snprintf(p, sizeof p, "%s/vkprobe-0.lock", sink.dir); unlink(p);
    rmdir(sink.dir);
}

/* wl-sink's stats lines within ms: "pictures" counts since the last line,
 * "drm" and "shm" are totals (so the newest one counts) */
static void sink_stats(int ms) {
    while (sink_line(ms))
        if (strstr(sink.line, "\"ev\":\"stats\"")) {
            sink.pictures += jnum(sink.line, "pictures");
            sink.drm = jnum(sink.line, "drm");
            sink.shm = jnum(sink.line, "shm");
            ms = 200;
        }
}

/* the snapshot: P6 256x256, the last picture, against pixel_ok's rule */
static int check_snap(int *right, int *wrong, int *black, char *first, size_t cap) {
    FILE *f = fopen(sink.snap, "rb");
    if (!f) return -1;
    int w, h, mx;
    if (fscanf(f, "P6 %d %d %d", &w, &h, &mx) != 3 || w != W || h != W || fgetc(f) == EOF) { fclose(f); return -1; }
    static uint8_t rgb[W * W * 3];
    size_t n = fread(rgb, 3, W * W, f);
    fclose(f);
    if (n != W * W) return -1;
    *right = *wrong = *black = 0;
    first[0] = 0;
    for (uint32_t y = 0; y < W; y++)
        for (uint32_t x = 0; x < W; x++) {
            const uint8_t *q = rgb + (y * W + x) * 3;
            uint8_t p4[4] = { q[0], q[1], q[2], 255 };
            int inside;
            *black += !q[0] && !q[1] && !q[2];
            if (pixel_ok(x, y, p4, &inside)) (*right)++;
            else if ((*wrong)++ == 0) snprintf(first, cap, "(%u,%u) = %u %u %u", x, y, q[0], q[1], q[2]);
        }
    return 0;
}

static struct wl_compositor *wl_comp;
static struct xdg_wm_base *wm;
static int configured;

static void reg_global(void *d, struct wl_registry *r, uint32_t name, const char *iface, uint32_t ver) {
    (void)d;
    if (!strcmp(iface, "wl_compositor")) wl_comp = wl_registry_bind(r, name, &wl_compositor_interface, ver < 4 ? ver : 4);
    else if (!strcmp(iface, "xdg_wm_base")) wm = wl_registry_bind(r, name, &xdg_wm_base_interface, 1);
}
static void reg_remove(void *d, struct wl_registry *r, uint32_t name) { (void)d; (void)r; (void)name; }
static const struct wl_registry_listener reg_l = { reg_global, reg_remove };
static void wm_ping(void *d, struct xdg_wm_base *b, uint32_t serial) { (void)d; xdg_wm_base_pong(b, serial); }
static const struct xdg_wm_base_listener wm_l = { wm_ping };
static void xs_configure(void *d, struct xdg_surface *s, uint32_t serial) { (void)d; xdg_surface_ack_configure(s, serial); configured = 1; }
static const struct xdg_surface_listener xs_l = { xs_configure };
static void tl_configure(void *d, struct xdg_toplevel *t, int32_t w, int32_t h, struct wl_array *st) { (void)d; (void)t; (void)w; (void)h; (void)st; }
static void tl_close(void *d, struct xdg_toplevel *t) { (void)d; (void)t; }
static const struct xdg_toplevel_listener tl_l = { tl_configure, tl_close };

static int present(VkInstance inst, VkPhysicalDevice pd, VkDevice dev, VkQueue q, uint32_t family) {
    struct wl_display *dpy = wl_display_connect("vkprobe-0");
    if (!dpy) { say("FAIL connecting to wl-sink: %s", strerror(errno)); return 1; }
    struct wl_registry *reg = wl_display_get_registry(dpy);
    wl_registry_add_listener(reg, &reg_l, 0);
    wl_display_roundtrip(dpy);
    if (!wl_comp || !wm) { say("FAIL wl-sink lacks wl_compositor or xdg_wm_base"); return 1; }
    xdg_wm_base_add_listener(wm, &wm_l, 0);
    struct wl_surface *ws = wl_compositor_create_surface(wl_comp);
    struct xdg_surface *xs = xdg_wm_base_get_xdg_surface(wm, ws);
    xdg_surface_add_listener(xs, &xs_l, 0);
    struct xdg_toplevel *tl = xdg_surface_get_toplevel(xs);
    xdg_toplevel_add_listener(tl, &tl_l, 0);
    xdg_toplevel_set_title(tl, "vkprobe");
    wl_surface_commit(ws);
    while (!configured && wl_display_roundtrip(dpy) >= 0) { }

    VkWaylandSurfaceCreateInfoKHR wsi = { VK_STRUCTURE_TYPE_WAYLAND_SURFACE_CREATE_INFO_KHR, 0, 0, dpy, ws };
    VkSurfaceKHR surf;
    CHECK(vkCreateWaylandSurfaceKHR(inst, &wsi, 0, &surf));
    VkBool32 sup = 0;
    CHECK(vkGetPhysicalDeviceSurfaceSupportKHR(pd, family, surf, &sup));
    if (!sup) { say("FAIL the queue can't present to Wayland"); return 1; }
    VkSurfaceCapabilitiesKHR caps;
    CHECK(vkGetPhysicalDeviceSurfaceCapabilitiesKHR(pd, surf, &caps));
    uint32_t nf = 0;
    CHECK(vkGetPhysicalDeviceSurfaceFormatsKHR(pd, surf, &nf, 0));
    VkSurfaceFormatKHR fmts[32];
    if (nf > 32) nf = 32;
    CHECK(vkGetPhysicalDeviceSurfaceFormatsKHR(pd, surf, &nf, fmts));
    VkFormat fmt = VK_FORMAT_UNDEFINED;
    char list[256] = "";
    for (uint32_t i = 0; i < nf; i++) {
        snprintf(list + strlen(list), sizeof list - strlen(list), "%s%d", i ? "," : "", (int)fmts[i].format);
        if (fmts[i].format == VK_FORMAT_B8G8R8A8_UNORM) fmt = fmts[i].format;
    }
    say("present: surface formats %s; images %u-%u", list, caps.minImageCount, caps.maxImageCount);
    if (fmt == VK_FORMAT_UNDEFINED) { say("FAIL no B8G8R8A8_UNORM to present"); return 1; }
    uint32_t nimg = caps.minImageCount + 1;
    if (caps.maxImageCount && nimg > caps.maxImageCount) nimg = caps.maxImageCount;
    VkSwapchainCreateInfoKHR sci = { VK_STRUCTURE_TYPE_SWAPCHAIN_CREATE_INFO_KHR, 0, 0, surf, nimg, fmt, VK_COLOR_SPACE_SRGB_NONLINEAR_KHR,
        { W, W }, 1, VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT, VK_SHARING_MODE_EXCLUSIVE, 0, 0,
        VK_SURFACE_TRANSFORM_IDENTITY_BIT_KHR, VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR, VK_PRESENT_MODE_FIFO_KHR, VK_TRUE, 0 };
    if (!(caps.supportedCompositeAlpha & VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR)) sci.compositeAlpha = VK_COMPOSITE_ALPHA_INHERIT_BIT_KHR;
    VkSwapchainKHR sc;
    CRUMB("probe: creating the swapchain");
    CHECK(vkCreateSwapchainKHR(dev, &sci, 0, &sc));
    VkImage imgs[8];
    CHECK(vkGetSwapchainImagesKHR(dev, sc, &nimg, 0));
    if (nimg > 8) nimg = 8;
    CHECK(vkGetSwapchainImagesKHR(dev, sc, &nimg, imgs));

    VkAttachmentDescription ad = { 0, fmt, VK_SAMPLE_COUNT_1_BIT, VK_ATTACHMENT_LOAD_OP_CLEAR, VK_ATTACHMENT_STORE_OP_STORE,
        VK_ATTACHMENT_LOAD_OP_DONT_CARE, VK_ATTACHMENT_STORE_OP_DONT_CARE, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_PRESENT_SRC_KHR };
    VkAttachmentReference ar = { 0, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL };
    VkSubpassDescription sd = { 0, VK_PIPELINE_BIND_POINT_GRAPHICS, 0, 0, 1, &ar, 0, 0, 0, 0 };
    VkSubpassDependency dep = { VK_SUBPASS_EXTERNAL, 0, VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT, VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT,
        0, VK_ACCESS_COLOR_ATTACHMENT_WRITE_BIT, 0 };
    VkRenderPassCreateInfo rpi = { VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO, 0, 0, 1, &ad, 1, &sd, 1, &dep };
    VkRenderPass rp;
    CHECK(vkCreateRenderPass(dev, &rpi, 0, &rp));
    VkImageView views[8];
    VkFramebuffer fbs[8];
    for (uint32_t i = 0; i < nimg; i++) {
        VkImageViewCreateInfo vi = { VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, 0, 0, imgs[i], VK_IMAGE_VIEW_TYPE_2D, fmt,
            { VK_COMPONENT_SWIZZLE_IDENTITY, VK_COMPONENT_SWIZZLE_IDENTITY, VK_COMPONENT_SWIZZLE_IDENTITY, VK_COMPONENT_SWIZZLE_IDENTITY },
            { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 } };
        CHECK(vkCreateImageView(dev, &vi, 0, &views[i]));
        VkFramebufferCreateInfo fbi = { VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO, 0, 0, rp, 1, &views[i], W, W, 1 };
        CHECK(vkCreateFramebuffer(dev, &fbi, 0, &fbs[i]));
    }
    VkShaderModuleCreateInfo vsi = { VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO, 0, 0, sizeof draw_vert_spv, draw_vert_spv };
    VkShaderModuleCreateInfo fsi = { VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO, 0, 0, sizeof draw_frag_spv, draw_frag_spv };
    VkShaderModule vs, fs;
    CHECK(vkCreateShaderModule(dev, &vsi, 0, &vs));
    CHECK(vkCreateShaderModule(dev, &fsi, 0, &fs));
    VkPipelineShaderStageCreateInfo stages[2] = {
        { VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, 0, 0, VK_SHADER_STAGE_VERTEX_BIT, vs, "main", 0 },
        { VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, 0, 0, VK_SHADER_STAGE_FRAGMENT_BIT, fs, "main", 0 } };
    VkPipelineVertexInputStateCreateInfo vin = { VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO, 0, 0, 0, 0, 0, 0 };
    VkPipelineInputAssemblyStateCreateInfo ia = { VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO, 0, 0, VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST, VK_FALSE };
    VkViewport vp = { 0, 0, W, W, 0, 1 };
    VkRect2D scr = { { 0, 0 }, { W, W } };
    VkPipelineViewportStateCreateInfo vps = { VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO, 0, 0, 1, &vp, 1, &scr };
    VkPipelineRasterizationStateCreateInfo rs = { VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO, 0, 0, VK_FALSE, VK_FALSE,
        VK_POLYGON_MODE_FILL, VK_CULL_MODE_NONE, VK_FRONT_FACE_COUNTER_CLOCKWISE, VK_FALSE, 0, 0, 0, 1.0f };
    VkPipelineMultisampleStateCreateInfo ms = { VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO, 0, 0, VK_SAMPLE_COUNT_1_BIT, VK_FALSE, 0, 0, VK_FALSE, VK_FALSE };
    VkPipelineColorBlendAttachmentState cba = { VK_FALSE, 0, 0, 0, 0, 0, 0,
        VK_COLOR_COMPONENT_R_BIT | VK_COLOR_COMPONENT_G_BIT | VK_COLOR_COMPONENT_B_BIT | VK_COLOR_COMPONENT_A_BIT };
    VkPipelineColorBlendStateCreateInfo cb = { VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO, 0, 0, VK_FALSE, 0, 1, &cba, { 0, 0, 0, 0 } };
    VkPipelineLayoutCreateInfo pli = { VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, 0, 0, 0, 0, 0, 0 };
    VkPipelineLayout pl;
    CHECK(vkCreatePipelineLayout(dev, &pli, 0, &pl));
    VkGraphicsPipelineCreateInfo gpi = { VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO, 0, 0, 2, stages, &vin, &ia, 0, &vps, &rs, &ms, 0, &cb, 0,
        pl, rp, 0, 0, -1 };
    VkPipeline pipe;
    CHECK(vkCreateGraphicsPipelines(dev, 0, 1, &gpi, 0, &pipe));

    /* one command buffer per swapchain image, recorded once */
    VkCommandPoolCreateInfo cpci = { VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO, 0, 0, family };
    VkCommandPool cp;
    CHECK(vkCreateCommandPool(dev, &cpci, 0, &cp));
    VkCommandBuffer cmds[8];
    VkCommandBufferAllocateInfo cbai = { VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO, 0, cp, VK_COMMAND_BUFFER_LEVEL_PRIMARY, nimg };
    CHECK(vkAllocateCommandBuffers(dev, &cbai, cmds));
    VkClearValue clear = { .color = { .float32 = { 0.0f, 0.0f, CLEAR_B / 255.0f, 1.0f } } };
    for (uint32_t i = 0; i < nimg; i++) {
        VkCommandBufferBeginInfo cbbi = { VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO, 0, 0, 0 };
        CHECK(vkBeginCommandBuffer(cmds[i], &cbbi));
        VkRenderPassBeginInfo rpb = { VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO, 0, rp, fbs[i], { { 0, 0 }, { W, W } }, 1, &clear };
        vkCmdBeginRenderPass(cmds[i], &rpb, VK_SUBPASS_CONTENTS_INLINE);
        vkCmdBindPipeline(cmds[i], VK_PIPELINE_BIND_POINT_GRAPHICS, pipe);
        vkCmdDraw(cmds[i], 3, 1, 0, 0);
        vkCmdEndRenderPass(cmds[i]);
        CHECK(vkEndCommandBuffer(cmds[i]));
    }
    VkSemaphoreCreateInfo semi = { VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO, 0, 0 };
    VkSemaphore acquired, rendered;
    CHECK(vkCreateSemaphore(dev, &semi, 0, &acquired));
    CHECK(vkCreateSemaphore(dev, &semi, 0, &rendered));
    VkFenceCreateInfo fi = { VK_STRUCTURE_TYPE_FENCE_CREATE_INFO, 0, 0 };
    VkFence f;
    CHECK(vkCreateFence(dev, &fi, 0, &f));

    CRUMB("probe: presenting %d frames", FRAMES);
    int presented = 0;
    for (int fr = 0; fr < FRAMES; fr++) {
        uint32_t idx;
        CHECK(vkAcquireNextImageKHR(dev, sc, 5000000000ull, acquired, VK_NULL_HANDLE, &idx));
        VkPipelineStageFlags wst = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT;
        VkSubmitInfo sub = { VK_STRUCTURE_TYPE_SUBMIT_INFO, 0, 1, &acquired, &wst, 1, &cmds[idx], 1, &rendered };
        CHECK(vkQueueSubmit(q, 1, &sub, f));
        VkPresentInfoKHR pi = { VK_STRUCTURE_TYPE_PRESENT_INFO_KHR, 0, 1, &rendered, 1, &sc, &idx, 0 };
        CHECK(vkQueuePresentKHR(q, &pi));
        CHECK(vkWaitForFences(dev, 1, &f, VK_TRUE, 5000000000ull));
        CHECK(vkResetFences(dev, 1, &f));
        wl_display_dispatch_pending(dpy);   /* xdg_wm_base pings */
        presented++;
    }
    CHECK(vkDeviceWaitIdle(dev));
    wl_display_roundtrip(dpy);
    CRUMB("probe: %d frames presented", presented);
    sink_stats(1500);   /* wl-sink's stats come once a second */
    int right = 0, wrong = 0, black = 0;
    char first[80];
    int got = check_snap(&right, &wrong, &black, first, sizeof first);
    say("present: %d frames presented; wl-sink made %ld pictures from %ld GPU (wl_drm) and %ld shared-memory buffers",
        presented, sink.pictures, sink.drm, sink.shm);
    if (got < 0) say("present: no snapshot from wl-sink");
    else say("present: wl-sink's picture: %d of %d pixels right, %d wrong, %d black%s%s", right, W * W, wrong, black,
             wrong ? ", first wrong " : "", wrong ? first : "");
    CRUMB("probe: present %d frames, sink %ld pictures %ld drm %ld shm, snap %d right %d wrong", presented, sink.pictures, sink.drm, sink.shm, right, wrong);
    int stub = getenv("INTEL_STUB_GPU_PLATFORM") != NULL;
    int ok = presented == FRAMES && sink.pictures > 0 && got == 0
        && (wrong == 0 || (stub && black == W * W && sink.drm > 0));
    if (ok && wrong) say("present: GPU buffers reached wl-sink, the picture black (the bench's stub GPU runs nothing): accepted on the bench only");

    vkDestroyFence(dev, f, 0);
    vkDestroySemaphore(dev, acquired, 0);
    vkDestroySemaphore(dev, rendered, 0);
    vkDestroyCommandPool(dev, cp, 0);
    vkDestroyPipeline(dev, pipe, 0);
    vkDestroyPipelineLayout(dev, pl, 0);
    vkDestroyShaderModule(dev, vs, 0);
    vkDestroyShaderModule(dev, fs, 0);
    for (uint32_t i = 0; i < nimg; i++) { vkDestroyFramebuffer(dev, fbs[i], 0); vkDestroyImageView(dev, views[i], 0); }
    vkDestroyRenderPass(dev, rp, 0);
    vkDestroySwapchainKHR(dev, sc, 0);
    vkDestroySurfaceKHR(inst, surf, 0);
    xdg_toplevel_destroy(tl);
    xdg_surface_destroy(xs);
    wl_surface_destroy(ws);
    wl_display_disconnect(dpy);
    return ok ? 0 : 1;
}

int main(int argc, char **argv) {
    crumb_fn = (void (*)(const char *, ...))dlsym(RTLD_DEFAULT, "vk_crumb");
    stop_after = -1;
    for (int i = 0; argc > 1 && i < 6; i++) if (!strcmp(argv[1], NAMES[i])) stop_after = i;
    if (stop_after < 0) { fprintf(stderr, "usage: vkprobe instance|enumerate|device|compute|draw|present\n"); return 2; }
    setvbuf(stdout, 0, _IOLBF, 0);
    int wsi = stop_after >= 5;   /* only the present stage asks for the window-system extensions */
    if (wsi && sink_start(argv[0]) < 0) { sink_stop(); return 1; }

    begin(0);
    const char *iext[] = { VK_KHR_SURFACE_EXTENSION_NAME, VK_KHR_WAYLAND_SURFACE_EXTENSION_NAME };
    VkApplicationInfo app = { VK_STRUCTURE_TYPE_APPLICATION_INFO, 0, "vkprobe", 1, 0, 0, VK_API_VERSION_1_0 };
    VkInstanceCreateInfo ici = { VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO, 0, 0, &app, 0, 0, wsi ? 2 : 0, wsi ? iext : 0 };
    VkInstance inst;
    CHECK(vkCreateInstance(&ici, 0, &inst));
    uint32_t ne = 0;
    vkEnumerateInstanceExtensionProperties(0, &ne, 0);
    say("instance: %u extensions offered, %s", ne, wsi ? "surface + wayland_surface enabled" : "none enabled");
    int rc = 0;
    if (end(0)) goto out_inst;

    begin(1);
    uint32_t n = 0;
    CHECK(vkEnumeratePhysicalDevices(inst, &n, 0));
    if (!n) { say("FAIL no physical device"); rc = 1; goto out_inst; }
    VkPhysicalDevice pds[4];
    if (n > 4) n = 4;
    CHECK(vkEnumeratePhysicalDevices(inst, &n, pds));
    VkPhysicalDevice pd = pds[0];
    VkPhysicalDeviceProperties p;
    vkGetPhysicalDeviceProperties(pd, &p);
    say("device: %s, Vulkan %u.%u.%u, driver %u.%u.%u, %04x:%04x", p.deviceName,
        VK_VERSION_MAJOR(p.apiVersion), VK_VERSION_MINOR(p.apiVersion), VK_VERSION_PATCH(p.apiVersion),
        VK_VERSION_MAJOR(p.driverVersion), VK_VERSION_MINOR(p.driverVersion), VK_VERSION_PATCH(p.driverVersion),
        p.vendorID, p.deviceID);
    uint32_t nq = 0;
    vkGetPhysicalDeviceQueueFamilyProperties(pd, &nq, 0);
    VkQueueFamilyProperties qf[8];
    if (nq > 8) nq = 8;
    vkGetPhysicalDeviceQueueFamilyProperties(pd, &nq, qf);
    uint32_t family = UINT32_MAX;
    for (uint32_t i = 0; i < nq; i++) if (qf[i].queueFlags & VK_QUEUE_COMPUTE_BIT) { family = i; break; }
    VkPhysicalDeviceMemoryProperties mp;
    vkGetPhysicalDeviceMemoryProperties(pd, &mp);
    say("queues: %u families, compute in %d; memory: %u heaps, heap 0 %llu MB", nq, (int)family, mp.memoryHeapCount,
        (unsigned long long)(mp.memoryHeaps[0].size >> 20));
    if (family == UINT32_MAX) { say("FAIL no compute queue"); rc = 1; goto out_inst; }
    if (end(1)) goto out_inst;

    begin(2);
    float prio = 1.0f;
    VkDeviceQueueCreateInfo qci = { VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO, 0, 0, family, 1, &prio };
    const char *dext[] = { VK_KHR_SWAPCHAIN_EXTENSION_NAME };
    VkDeviceCreateInfo dci = { VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO, 0, 0, 1, &qci, 0, 0, wsi ? 1 : 0, wsi ? dext : 0, 0 };
    VkDevice dev;
    CHECK(vkCreateDevice(pd, &dci, 0, &dev));
    VkQueue q;
    vkGetDeviceQueue(dev, family, 0, &q);
    CHECK(vkDeviceWaitIdle(dev));
    if (end(2)) goto out_dev;

    begin(3);
    rc = compute(pd, dev, q, family);
    if (rc || end(3)) goto out_dev;

    begin(4);
    if (!(qf[family].queueFlags & VK_QUEUE_GRAPHICS_BIT)) { say("FAIL the queue has no graphics"); rc = 1; goto out_dev; }
    rc = draw(pd, dev, q, family);
    if (rc || end(4)) goto out_dev;

    begin(5);
    rc = present(inst, pd, dev, q, family);
    if (!rc) end(5);
out_dev:
    vkDestroyDevice(dev, 0);
out_inst:
    vkDestroyInstance(inst, 0);
    if (wsi) sink_stop();
    CRUMB("probe: done, %d", rc);
    say("probe: %s", rc ? "failed" : "done");
    return rc;
}
