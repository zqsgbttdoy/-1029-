package com.supervision.controller;

import com.supervision.annotation.RequireRole;
import com.supervision.common.ApiResponse;
import com.supervision.common.PageResult;
import com.supervision.dto.ApproveDTO;
import com.supervision.dto.SupervisionDiaryDTO;
import com.supervision.entity.SupervisionDiary;
import com.supervision.service.DiaryAttachmentService;
import com.supervision.service.SupervisionDiaryService;
import jakarta.validation.Valid;
import lombok.AllArgsConstructor;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/supervision-diaries")
public class SupervisionDiaryController extends FieldRecordController {

    private final DiaryAttachmentService diaryAttachments;

    public SupervisionDiaryController(com.supervision.service.FieldRecordService records,
                                      DiaryAttachmentService diaryAttachments) {
        super(records, com.supervision.common.FieldRecordKind.DIARY);
        this.diaryAttachments = diaryAttachments;
    }

    @GetMapping("/{id}/related-attachments")
    public ApiResponse<?> relatedAttachments(@PathVariable Long id) {
        return ApiResponse.success(diaryAttachments.related(id));
    }

    @PutMapping("/{id}/related-attachments/{documentId}")
    public ApiResponse<?> attach(@PathVariable Long id, @PathVariable Long documentId) {
        return ApiResponse.success(diaryAttachments.attach(id, documentId));
    }

    @DeleteMapping("/{id}/related-attachments/{documentId}")
    public ApiResponse<?> detach(@PathVariable Long id, @PathVariable Long documentId) {
        return ApiResponse.success(diaryAttachments.detach(id, documentId));
    }

    // CRUD、提交、审核及历史接口统一继承，审核权限由项目授权决定。
}
