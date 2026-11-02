package com.supervision;

import com.supervision.dto.ReplyDTO;
import com.supervision.dto.SupervisionNoticeDTO;
import com.supervision.entity.SupervisionNotice;
import com.supervision.exception.BusinessException;
import com.supervision.repository.SupervisionNoticeRepository;
import com.supervision.service.SupervisionNoticeService;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.LocalDate;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
@DisplayName("SupervisionNoticeService 单元测试")
class SupervisionNoticeServiceTest {

    @Mock
    private SupervisionNoticeRepository supervisionNoticeRepository;

    @Mock private com.supervision.service.ProjectAccessService access;
    @Mock private com.supervision.service.AttachmentAccessService attachmentAccess;
    @Mock private com.supervision.service.DiaryReferenceService diaryReferences;
    @Mock private com.supervision.service.DiaryResourceResolver diaryResources;

    @org.junit.jupiter.api.BeforeEach
    void identity() {
        var user = new com.supervision.entity.User();
        user.setId(1L);
        lenient().when(access.currentUser()).thenReturn(user);
        lenient().when(diaryResources.load(eq("supervision-notices"), anyLong(), eq(true)))
                .thenAnswer(call -> supervisionNoticeRepository.findById(call.getArgument(1))
                        .orElseThrow(() -> new BusinessException("监理通知不存在")));
    }

    @InjectMocks
    private SupervisionNoticeService supervisionNoticeService;

    @Test
    void deniedProjectCannotCreate() {
        doThrow(new BusinessException(403, "无项目权限")).when(access).requireRead(1L);
        assertThrows(BusinessException.class, () -> supervisionNoticeService.create(buildNoticeDTO()));
        verifyNoInteractions(supervisionNoticeRepository, attachmentAccess);
    }

    private SupervisionNoticeDTO buildNoticeDTO() {
        SupervisionNoticeDTO dto = new SupervisionNoticeDTO();
        dto.setCode("JL-TZ-20240101");
        dto.setProjectId(1L);
        dto.setNoticeDate(LocalDate.of(2024, 1, 15));
        dto.setAuthorId(1L);
        dto.setTitle("施工整改通知");
        dto.setContent("请于3日内完成整改");
        dto.setDeadline(LocalDate.of(2024, 1, 18));
        dto.setPriority("high");
        return dto;
    }

    private SupervisionNotice buildExistingNotice() {
        SupervisionNotice notice = new SupervisionNotice();
        notice.setId(1L);
        notice.setCode("JL-TZ-20240101");
        notice.setProjectId(1L);
        notice.setNoticeDate(LocalDate.of(2024, 1, 15));
        notice.setTitle("施工整改通知");
        notice.setContent("请于3日内完成整改");
        notice.setStatus("issued");
        return notice;
    }

    @Test
    @DisplayName("创建通知单 - 验证默认status=draft")
    void testCreateNotice() {
        SupervisionNoticeDTO dto = buildNoticeDTO();
        when(supervisionNoticeRepository.findByCode(dto.getCode())).thenReturn(Optional.empty());
        when(supervisionNoticeRepository.save(any(SupervisionNotice.class))).thenAnswer(invocation -> {
            SupervisionNotice notice = invocation.getArgument(0);
            notice.setId(1L);
            return notice;
        });

        SupervisionNotice result = supervisionNoticeService.create(dto);

        assertNotNull(result);
        assertEquals("draft", result.getStatus());
        assertEquals("JL-TZ-20240101", result.getCode());
        assertEquals("施工整改通知", result.getTitle());
        assertEquals("请于3日内完成整改", result.getContent());
        assertEquals("high", result.getPriority());
        assertEquals(LocalDate.of(2024, 1, 18), result.getDeadline());
        verify(supervisionNoticeRepository).save(any(SupervisionNotice.class));
    }

    @Test
    @DisplayName("创建通知单 - 编号已存在应抛出BusinessException")
    void testCreateNoticeWithDuplicateCode() {
        SupervisionNoticeDTO dto = buildNoticeDTO();
        SupervisionNotice existing = buildExistingNotice();
        when(supervisionNoticeRepository.findByCode(dto.getCode())).thenReturn(Optional.of(existing));

        BusinessException exception = assertThrows(BusinessException.class,
                () -> supervisionNoticeService.create(dto));
        assertEquals("编号已存在", exception.getMessage());
        verify(supervisionNoticeRepository, never()).save(any());
    }

    @Test
    @DisplayName("创建通知单 - 编号存在但status为inactive时允许创建")
    void testCreateNoticeWithInactiveCode() {
        SupervisionNoticeDTO dto = buildNoticeDTO();
        SupervisionNotice inactiveNotice = buildExistingNotice();
        inactiveNotice.setStatus("inactive");
        when(supervisionNoticeRepository.findByCode(dto.getCode())).thenReturn(Optional.of(inactiveNotice));
        when(supervisionNoticeRepository.save(any(SupervisionNotice.class))).thenAnswer(invocation -> {
            SupervisionNotice notice = invocation.getArgument(0);
            notice.setId(2L);
            return notice;
        });

        SupervisionNotice result = supervisionNoticeService.create(dto);

        assertNotNull(result);
        assertEquals("draft", result.getStatus());
    }

    @Test
    @DisplayName("创建通知单 - DTO传入status=issued时应设置status为issued")
    void testCreateWithDTOStatus() {
        SupervisionNoticeDTO dto = buildNoticeDTO();
        dto.setStatus("issued");
        when(supervisionNoticeRepository.findByCode(dto.getCode())).thenReturn(Optional.empty());
        when(supervisionNoticeRepository.save(any(SupervisionNotice.class))).thenAnswer(invocation -> {
            SupervisionNotice notice = invocation.getArgument(0);
            notice.setId(1L);
            return notice;
        });

        SupervisionNotice result = supervisionNoticeService.create(dto);

        assertEquals("issued", result.getStatus());
    }

    @Test
    @DisplayName("回复通知单 - issued状态可回复，验证status=responded")
    void testReplyNotice() {
        SupervisionNotice notice = buildExistingNotice();
        // buildExistingNotice()已设置status=issued
        when(supervisionNoticeRepository.findById(1L)).thenReturn(Optional.of(notice));
        when(supervisionNoticeRepository.save(any(SupervisionNotice.class))).thenAnswer(invocation -> invocation.getArgument(0));

        ReplyDTO dto = new ReplyDTO();
        dto.setId(1L);
        dto.setReplyContent("已完成整改，请审核");

        SupervisionNotice result = supervisionNoticeService.reply(dto);

        assertNotNull(result);
        assertEquals("responded", result.getStatus());
        assertEquals("已完成整改，请审核", result.getReplyContent());
        assertNotNull(result.getReplyDate());
        assertEquals(LocalDate.now(), result.getReplyDate());
        verify(supervisionNoticeRepository).save(any(SupervisionNotice.class));
    }

    @Test
    @DisplayName("回复通知单 - 不存在的ID应抛出BusinessException")
    void testReplyNonExistentNotice() {
        when(supervisionNoticeRepository.findById(999L)).thenReturn(Optional.empty());

        ReplyDTO dto = new ReplyDTO();
        dto.setId(999L);
        dto.setReplyContent("回复内容");

        BusinessException exception = assertThrows(BusinessException.class,
                () -> supervisionNoticeService.reply(dto));
        assertEquals("监理通知不存在", exception.getMessage());
        verify(supervisionNoticeRepository, never()).save(any());
    }

    @Test
    @DisplayName("回复通知单 - overdue状态可回复")
    void testReplyOverdueNotice() {
        SupervisionNotice notice = buildExistingNotice();
        notice.setStatus("overdue");
        when(supervisionNoticeRepository.findById(1L)).thenReturn(Optional.of(notice));
        when(supervisionNoticeRepository.save(any(SupervisionNotice.class))).thenAnswer(invocation -> invocation.getArgument(0));

        ReplyDTO dto = new ReplyDTO();
        dto.setId(1L);
        dto.setReplyContent("逾期回复");

        SupervisionNotice result = supervisionNoticeService.reply(dto);

        assertEquals("responded", result.getStatus());
        verify(supervisionNoticeRepository).save(any(SupervisionNotice.class));
    }

    @Test
    @DisplayName("回复通知单 - draft状态不可回复应抛出BusinessException")
    void testReplyDraftNotice() {
        SupervisionNotice notice = buildExistingNotice();
        notice.setStatus("draft");
        when(supervisionNoticeRepository.findById(1L)).thenReturn(Optional.of(notice));

        ReplyDTO dto = new ReplyDTO();
        dto.setId(1L);
        dto.setReplyContent("回复内容");

        BusinessException exception = assertThrows(BusinessException.class,
                () -> supervisionNoticeService.reply(dto));
        assertEquals("只有已下发或已逾期状态的通知单才能回复", exception.getMessage());
        verify(supervisionNoticeRepository, never()).save(any());
    }

    @Test
    @DisplayName("更新通知单 - 新code已被其他active记录占用应抛出BusinessException")
    void testUpdateWithDuplicateCode() {
        SupervisionNotice existing = buildExistingNotice();
        SupervisionNotice otherRecord = buildExistingNotice();
        otherRecord.setId(2L);
        otherRecord.setCode("JL-TZ-OTHER");
        when(supervisionNoticeRepository.findById(1L)).thenReturn(Optional.of(existing));
        when(supervisionNoticeRepository.findByCode("JL-TZ-OTHER")).thenReturn(Optional.of(otherRecord));

        SupervisionNoticeDTO dto = buildNoticeDTO();
        dto.setCode("JL-TZ-OTHER");

        BusinessException exception = assertThrows(BusinessException.class,
                () -> supervisionNoticeService.update(1L, dto));
        assertEquals("编号已存在", exception.getMessage());
        verify(supervisionNoticeRepository, never()).save(any());
    }

    @Test
    @DisplayName("更新通知单 - 新code仅被inactive记录占用时允许更新")
    void testUpdateWithInactiveDuplicateCode() {
        SupervisionNotice existing = buildExistingNotice();
        SupervisionNotice inactiveRecord = buildExistingNotice();
        inactiveRecord.setId(2L);
        inactiveRecord.setCode("JL-TZ-OTHER");
        inactiveRecord.setStatus("inactive");
        when(supervisionNoticeRepository.findById(1L)).thenReturn(Optional.of(existing));
        when(supervisionNoticeRepository.findByCode("JL-TZ-OTHER")).thenReturn(Optional.of(inactiveRecord));
        when(supervisionNoticeRepository.save(any(SupervisionNotice.class))).thenAnswer(invocation -> invocation.getArgument(0));

        SupervisionNoticeDTO dto = buildNoticeDTO();
        dto.setCode("JL-TZ-OTHER");

        SupervisionNotice result = supervisionNoticeService.update(1L, dto);

        assertEquals("JL-TZ-OTHER", result.getCode());
        verify(supervisionNoticeRepository).save(any());
    }

    @Test
    @DisplayName("更新通知单 - 新code与自身原code相同允许更新")
    void testUpdateWithSameCode() {
        SupervisionNotice existing = buildExistingNotice();
        when(supervisionNoticeRepository.findById(1L)).thenReturn(Optional.of(existing));
        when(supervisionNoticeRepository.save(any(SupervisionNotice.class))).thenAnswer(invocation -> invocation.getArgument(0));

        SupervisionNoticeDTO dto = buildNoticeDTO();
        dto.setTitle("新标题");

        SupervisionNotice result = supervisionNoticeService.update(1L, dto);

        assertEquals("新标题", result.getTitle());
        verify(supervisionNoticeRepository).save(any());
        verify(supervisionNoticeRepository, never()).findByCode(any());
    }

    @Test
    @DisplayName("删除通知单 - 应设置status为inactive")
    void testDeleteNotice() {
        SupervisionNotice notice = buildExistingNotice();
        when(supervisionNoticeRepository.findById(1L)).thenReturn(Optional.of(notice));
        when(supervisionNoticeRepository.save(any(SupervisionNotice.class))).thenAnswer(invocation -> invocation.getArgument(0));

        supervisionNoticeService.delete(1L);

        verify(supervisionNoticeRepository).save(argThat(n -> "inactive".equals(n.getStatus())));
        verify(diaryResources).load("supervision-notices", 1L, true);
        verify(diaryReferences).invalidate("supervision-notices", notice, true);
    }

    @Test
    @DisplayName("根据ID查询 - 通知不存在应抛出BusinessException")
    void testGetByIdNotFound() {
        when(supervisionNoticeRepository.findById(999L)).thenReturn(Optional.empty());

        BusinessException exception = assertThrows(BusinessException.class,
                () -> supervisionNoticeService.getById(999L));
        assertEquals("监理通知不存在", exception.getMessage());
    }
}
