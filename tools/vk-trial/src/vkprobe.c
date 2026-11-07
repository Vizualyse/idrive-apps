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
//
// Never asks for VK_KHR_display (that would open the display node). Each
// stage leaves a crumb (vk_crumbs.so) before and after. On the bench's stub
// GPU nothing runs, so the numbers come back unchanged: accepted there
// (INTEL_STUB_GPU_PLATFORM set) as "not run".

#define _GNU_SOURCE
#include <dlfcn.h>
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
static const char *NAMES[] = { "instance", "enumerate", "device", "compute", "draw" };

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

int main(int argc, char **argv) {
    crumb_fn = (void (*)(const char *, ...))dlsym(RTLD_DEFAULT, "vk_crumb");
    stop_after = -1;
    for (int i = 0; argc > 1 && i < 5; i++) if (!strcmp(argv[1], NAMES[i])) stop_after = i;
    if (stop_after < 0) { fprintf(stderr, "usage: vkprobe instance|enumerate|device|compute|draw\n"); return 2; }
    setvbuf(stdout, 0, _IOLBF, 0);

    begin(0);
    VkApplicationInfo app = { VK_STRUCTURE_TYPE_APPLICATION_INFO, 0, "vkprobe", 1, 0, 0, VK_API_VERSION_1_0 };
    VkInstanceCreateInfo ici = { VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO, 0, 0, &app, 0, 0, 0, 0 };
    VkInstance inst;
    CHECK(vkCreateInstance(&ici, 0, &inst));
    uint32_t ne = 0;
    vkEnumerateInstanceExtensionProperties(0, &ne, 0);
    say("instance: %u extensions offered (none enabled)", ne);
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
    VkDeviceCreateInfo dci = { VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO, 0, 0, 1, &qci, 0, 0, 0, 0, 0 };
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
    if (!rc) end(4);
out_dev:
    vkDestroyDevice(dev, 0);
out_inst:
    vkDestroyInstance(inst, 0);
    CRUMB("probe: done, %d", rc);
    say("probe: %s", rc ? "failed" : "done");
    return rc;
}
